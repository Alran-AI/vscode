import type * as acp from '@agentclientprotocol/sdk';

import {
  AlranAgent,
  errorMessage,
  isAuthRequired,
  type AgentExit,
  type AgentHandlers,
} from '../acp/agent';
import type {
  ConnectionState,
  SessionMeta,
  TabView,
  TranscriptItem,
} from '../shared/types';
import { SessionController, type AttentionEvent } from './session';

export interface PersistedSessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

export interface ManagerListener {
  connection(state: ConnectionState): void;
  tabs(tabs: readonly TabView[], activeId: string | undefined): void;
  items(sessionId: string, items: readonly TranscriptItem[]): void;
  meta(meta: SessionMeta): void;
  snapshot(sessionId: string): void;
  changes(sessionId: string): void;
  attention(event: AttentionEvent): void;
  turn(sessionId: string, running: boolean): void;
  log(line: string): void;
}

export interface ManagerHost {
  /** Builds the agent, or throws `AlranCliNotFoundError`. */
  createAgent(handlers: AgentHandlers): Promise<AlranAgent>;
  mcpServers(): acp.McpServer[];
  enterWhileRunning(): 'steer' | 'queue';
}

export class AuthRequiredError extends Error {
  constructor() {
    super('Sign in to Alran Code to continue.');
    this.name = 'AuthRequiredError';
  }
}

const MAX_AUTOMATIC_RESTARTS = 3;

/** Owns the agent process and every open Session attached to it. */
export class SessionManager {
  readonly sessions = new Map<string, SessionController>();
  private agent: AlranAgent | undefined;
  private connecting: Promise<AlranAgent> | undefined;
  private restarts = 0;
  private disposed = false;
  private currentActiveId: string | undefined;
  private currentConnection: ConnectionState = { state: 'disconnected' };

  constructor(
    private readonly host: ManagerHost,
    private readonly listener: ManagerListener,
  ) {}

  get connection(): ConnectionState {
    return this.currentConnection;
  }

  get activeId(): string | undefined {
    return this.currentActiveId;
  }

  get active(): SessionController | undefined {
    return this.currentActiveId ? this.sessions.get(this.currentActiveId) : undefined;
  }

  get agentVersion(): string | undefined {
    return this.agent?.version;
  }

  get tabs(): TabView[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.displayTitle,
      status: session.meta.status,
      ...(session.meta.isSide ? { isSide: true } : {}),
    }));
  }

  connect(): Promise<AlranAgent> {
    if (this.agent?.running) return Promise.resolve(this.agent);
    if (this.connecting) return this.connecting;
    this.setConnection({ state: 'connecting' });
    this.connecting = this.host
      .createAgent(this.handlers())
      .then(async (agent) => {
        await agent.start();
        this.agent = agent;
        this.restarts = 0;
        this.setConnection({
          state: 'connected',
          ...(agent.version ? { version: agent.version } : {}),
        });
        return agent;
      })
      .catch((error: unknown) => {
        const name = (error as { name?: string }).name;
        this.setConnection(
          name === 'AlranCliNotFoundError'
            ? { state: 'missing-binary', detail: errorMessage(error) }
            : { state: 'error', detail: errorMessage(error) },
        );
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private requireAgent = (): AlranAgent => {
    if (!this.agent?.running) throw new Error('The Alran agent is not running.');
    return this.agent;
  };

  private createController(
    id: string,
    cwd: string,
    options: { readonly isSide?: boolean; readonly title?: string } = {},
  ): SessionController {
    const session = new SessionController(
      id,
      cwd,
      {
        agent: this.requireAgent,
        mcpServers: () => this.host.mcpServers(),
        enterWhileRunning: () => this.host.enterWhileRunning(),
        listener: {
          items: (sessionId, items) => this.listener.items(sessionId, items),
          meta: (meta) => {
            this.listener.meta(meta);
            this.emitTabs();
          },
          snapshot: (sessionId) => this.listener.snapshot(sessionId),
          changes: (sessionId) => this.listener.changes(sessionId),
          attention: (event) => this.listener.attention(event),
          turn: (sessionId, running) => this.listener.turn(sessionId, running),
          authRequired: () => this.setConnection({ state: 'auth-required' }),
        },
      },
      options,
    );
    this.sessions.set(id, session);
    return session;
  }

  async newSession(cwd: string): Promise<SessionController> {
    const agent = await this.connect();
    const response = await this.withAuthCheck(() => agent.newSession(cwd, this.host.mcpServers()));
    const session = this.createController(response.sessionId, cwd);
    session.applyControlState(response);
    session.markReady();
    this.setActive(session.id);
    void session.refreshExtensions();
    return session;
  }

  async openSession(id: string, cwd: string, title?: string): Promise<SessionController> {
    const existing = this.sessions.get(id);
    if (existing) {
      this.setActive(id);
      return existing;
    }
    await this.connect();
    const session = this.createController(id, cwd, title ? { title } : {});
    this.setActive(id);
    try {
      await this.withAuthCheck(() => session.attach());
    } catch (error) {
      this.sessions.delete(id);
      session.dispose();
      if (this.currentActiveId === id) this.setActive(this.sessions.keys().next().value);
      throw error;
    }
    return session;
  }

  /** Forks a Session. `side` marks a temporary `/btw` side conversation. */
  async forkSession(id: string, options: { readonly side?: boolean } = {}): Promise<SessionController> {
    const source = this.sessions.get(id);
    if (!source) throw new Error('That Session is not open.');
    const agent = await this.connect();
    const response = await agent.forkSession(id, source.meta.cwd, this.host.mcpServers());
    const session = this.createController(response.sessionId, source.meta.cwd, {
      ...(options.side ? { isSide: true, title: `Side: ${source.displayTitle}` } : {}),
    });
    this.setActive(session.id);
    await session.attach();
    return session;
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.busy) await session.cancel().catch(() => undefined);
    session.dispose();
    this.sessions.delete(id);
    if (this.agent?.running) await this.agent.closeSession(id).catch(() => undefined);
    if (this.currentActiveId === id) {
      this.currentActiveId = undefined;
      this.setActive(this.sessions.keys().next().value);
    }
    this.emitTabs();
  }

  /** Releases the ACP attachment so another Alran process can own the Session. */
  async detachForTui(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.markDetached('This Session is open in the TUI.');
    await this.agent?.closeSession(id).catch(() => undefined);
  }

  /** Reloads a Session the TUI may have changed. */
  async reattachSession(id: string): Promise<void> {
    await this.connect();
    await this.sessions.get(id)?.attach();
  }

  /** Lists persisted Sessions across every page. */
  async listSessions(cwd?: string, limit = 500): Promise<PersistedSessionInfo[]> {
    const agent = await this.connect();
    const sessions: PersistedSessionInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.withAuthCheck(() =>
        agent.listSessions({ ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }),
      );
      for (const session of page.sessions) {
        sessions.push({
          sessionId: session.sessionId,
          cwd: session.cwd,
          ...(session.title ? { title: session.title } : {}),
          ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && sessions.length < limit);
    return sessions;
  }

  setActive(id: string | undefined): void {
    this.currentActiveId = id;
    this.emitTabs();
    this.listener.snapshot(id ?? '');
    if (id && this.agent?.running && this.sessions.has(id)) {
      void this.agent.activate(id).catch(() => undefined);
    }
  }

  /** Restarts the process (config or plugin reload) and reattaches open Sessions. */
  async restart(): Promise<void> {
    const openSessions = [...this.sessions.values()];
    for (const session of openSessions) session.markDetached('The agent was restarted.');
    const agent = this.agent;
    this.agent = undefined;
    await agent?.stop();
    await this.connect();
    await this.reattach(openSessions);
  }

  private async reattach(sessions: readonly SessionController[]): Promise<void> {
    for (const session of sessions) {
      await session.attach().catch((error: unknown) => {
        session.pushNotice('error', `Could not reopen this Session: ${errorMessage(error)}`);
      });
    }
  }

  private async withAuthCheck<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isAuthRequired(error)) {
        this.setConnection({ state: 'auth-required' });
        throw new AuthRequiredError();
      }
      throw error;
    }
  }

  private handleExit(info: AgentExit): void {
    if (this.disposed || info.expected) return;
    this.agent = undefined;
    const detail = `The Alran agent stopped unexpectedly (code ${String(info.code)}).`;
    const open = [...this.sessions.values()];
    for (const session of open) session.markDetached(detail);
    if (this.restarts >= MAX_AUTOMATIC_RESTARTS) {
      this.setConnection({
        state: 'error',
        detail: info.lastStderr ? `${detail}\n${info.lastStderr}` : detail,
      });
      return;
    }
    this.restarts += 1;
    this.setConnection({ state: 'connecting' });
    setTimeout(() => {
      this.connect()
        .then(() => this.reattach(open))
        .catch(() => undefined);
    }, 500 * this.restarts);
  }

  private handlers(): AgentHandlers {
    return {
      onUpdate: ({ sessionId, update }) => this.sessions.get(sessionId)?.handleUpdate(update),
      onPermission: (params, signal) => {
        const session = this.sessions.get(params.sessionId);
        return session
          ? session.requestPermission(params, signal)
          : Promise.resolve({ outcome: { outcome: 'cancelled' } });
      },
      onElicitation: (params, signal) => {
        const session =
          'sessionId' in params && typeof params.sessionId === 'string'
            ? this.sessions.get(params.sessionId)
            : this.active;
        return session
          ? session.requestElicitation(params, signal)
          : Promise.resolve({ action: 'cancel' });
      },
      onQueueUpdate: (sessionId, items) => this.sessions.get(sessionId)?.handleRuntimeQueue(items),
      onGoalUpdate: (sessionId, goal) => this.sessions.get(sessionId)?.handleGoal(goal),
      onDelegationUpdate: (sessionId, snapshot) =>
        this.sessions.get(sessionId)?.handleDelegation(snapshot),
      onCurrentSession: () => undefined,
      onLog: (line) => this.listener.log(line),
      onExit: (info) => this.handleExit(info),
    };
  }

  private setConnection(state: ConnectionState): void {
    this.currentConnection = state;
    this.listener.connection(state);
  }

  private emitTabs(): void {
    this.listener.tabs(this.tabs, this.currentActiveId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.values()) session.dispose();
    await this.agent?.stop();
    this.agent = undefined;
  }
}
