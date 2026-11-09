import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import { spawnCommand, type ResolvedCli } from './binary';

/** JSON-RPC code ACP uses when `alran login` has not been completed. */
export const AUTH_REQUIRED_CODE = -32000;

export const EXTENSION_NAMESPACE = 'alran-code/extensions';
const EXTENSION_VERSION = 1;

export interface AgentLaunchOptions {
  readonly cli: ResolvedCli;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Extra arguments placed before the `acp` subcommand (for example `--lane`). */
  readonly globalArgs?: readonly string[];
  /** Arguments after the `acp` subcommand (system prompt overrides). */
  readonly acpArgs?: readonly string[];
  readonly clientVersion?: string;
}

export interface AgentHandlers {
  onUpdate(params: acp.SessionNotification): void;
  onPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  onElicitation(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
  onQueueUpdate(sessionId: string, items: readonly RuntimeQueueItem[]): void;
  onGoalUpdate(sessionId: string, goal: unknown): void;
  onDelegationUpdate(sessionId: string, snapshot: DelegationSnapshot): void;
  onCurrentSession(sessionId: string | null): void;
  onLog(line: string): void;
  onExit(info: AgentExit): void;
}

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  readonly lastStderr: string;
}

export interface RuntimeQueueItem {
  readonly itemId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly source: string;
  readonly content: string;
}

export interface DelegatedAgent {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly agentName?: string;
  readonly task?: string;
  readonly status: string;
  readonly errorMessage?: string;
}

export interface DelegationSnapshot {
  readonly rootSessionId: string;
  readonly members: readonly DelegatedAgent[];
}

export interface DelegationStopReceipt {
  readonly rootStopped: boolean;
  readonly stoppedSessionIds: readonly string[];
  readonly activeSessionIds: readonly string[];
  readonly failedSessionIds: readonly string[];
}

export interface GoalPatch {
  readonly status?: 'active' | 'paused' | 'blocked' | 'complete' | 'budget_limited';
  readonly objective?: string;
  readonly tokenBudget?: number | null;
}

const identity = <T>(value: unknown): T => value as T;
const STDERR_TAIL_BYTES = 8_192;

/**
 * One `alran acp` process and its ACP connection. Free of `vscode` imports so
 * the protocol layer can be tested against the real CLI in plain Node.
 */
export class AlranAgent {
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: acp.ClientConnection | undefined;
  private stopping = false;
  private stderrTail = '';
  initializeResult: acp.InitializeResponse | undefined;

  constructor(
    private readonly options: AgentLaunchOptions,
    private readonly handlers: AgentHandlers,
  ) {}

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  get version(): string | undefined {
    return this.initializeResult?.agentInfo?.version;
  }

  get extensionMethods(): ReadonlySet<string> {
    const raw = this.initializeResult?._meta?.[EXTENSION_NAMESPACE] as
      | { readonly methods?: readonly string[] }
      | undefined;
    return new Set(raw?.methods ?? []);
  }

  private get agent(): acp.ClientContext {
    if (!this.connection) throw new Error('The Alran agent is not connected.');
    return this.connection.agent;
  }

  async start(): Promise<acp.InitializeResponse> {
    const { cli, cwd, env, globalArgs = [], acpArgs = [] } = this.options;
    const spawnSpec = spawnCommand(cli, [...globalArgs, 'acp', ...acpArgs]);
    const child = spawn(spawnSpec.command, [...spawnSpec.args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatim === true,
    });
    this.child = child;

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        reject(new Error(`Could not start ${cli.displayPath}: ${error.message}`));
      });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      for (const line of chunk.split(/\r?\n/u)) if (line.trim()) this.handlers.onLog(line);
    });
    const exited = new Promise<never>((_, reject) => {
      child.once('close', (code, signal) => {
        const info: AgentExit = {
          code,
          signal,
          expected: this.stopping,
          lastStderr: this.stderrTail.trim(),
        };
        this.child = undefined;
        this.connection?.close(new Error('The Alran agent process exited.'));
        this.connection = undefined;
        this.handlers.onExit(info);
        reject(
          new Error(
            `The Alran agent exited during startup (code ${String(code)}).${
              info.lastStderr ? `\n${info.lastStderr}` : ''
            }`,
          ),
        );
      });
    });
    // Rejections are consumed by the startup race; later ones have no listener.
    spawnFailure.catch(() => undefined);
    exited.catch(() => undefined);

    child.stdin.on('error', () => undefined);
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.connection = this.buildClient().connect(stream);
    void this.connection.closed.catch(() => undefined);

    const initialize = this.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: 'alran-vscode',
        title: 'Alran Code for VS Code',
        version: this.options.clientVersion ?? '0.0.0',
      },
      clientCapabilities: {
        auth: { terminal: true },
        elicitation: { form: {} },
        plan: {},
        _meta: {
          [EXTENSION_NAMESPACE]: { version: EXTENSION_VERSION, notifications: true },
          'terminal-auth': true,
        },
      },
    });
    this.initializeResult = await Promise.race([initialize, spawnFailure, exited]);
    return this.initializeResult;
  }

  private buildClient(): acp.ClientApp {
    const { handlers } = this;
    return acp
      .client({ name: 'alran-vscode' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        handlers.onUpdate(params);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) =>
        handlers.onPermission(params, signal),
      )
      .onRequest(acp.methods.client.elicitation.create, ({ params, signal }) =>
        handlers.onElicitation(params, signal),
      )
      .onNotification(
        'alran/session/queue_update',
        identity<{ sessionId: string; items: RuntimeQueueItem[] }>,
        ({ params }) => handlers.onQueueUpdate(params.sessionId, params.items),
      )
      .onNotification(
        'alran/session/goal_update',
        identity<{ sessionId: string; goal: unknown }>,
        ({ params }) => handlers.onGoalUpdate(params.sessionId, params.goal),
      )
      .onNotification(
        'alran/session/delegation_update',
        identity<{ sessionId: string; snapshot: DelegationSnapshot }>,
        ({ params }) => handlers.onDelegationUpdate(params.sessionId, params.snapshot),
      )
      .onNotification(
        'alran/session/current_session_update',
        identity<{ sessionId: string | null }>,
        ({ params }) => handlers.onCurrentSession(params.sessionId),
      );
  }

  /** Stops the process, escalating when it ignores SIGTERM. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.connection?.close(new Error('The Alran agent is shutting down.'));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await closed;
    clearTimeout(timer);
  }

  newSession(cwd: string, mcpServers: acp.McpServer[]): Promise<acp.NewSessionResponse> {
    return this.agent.request(acp.methods.agent.session.new, { cwd, mcpServers });
  }

  listSessions(params: { cwd?: string; cursor?: string }): Promise<acp.ListSessionsResponse> {
    return this.agent.request(acp.methods.agent.session.list, params);
  }

  loadSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[]): Promise<acp.LoadSessionResponse> {
    return this.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers });
  }

  forkSession(sessionId: string, cwd: string, mcpServers: acp.McpServer[]): Promise<acp.ForkSessionResponse> {
    return this.agent.request(acp.methods.agent.session.fork, { sessionId, cwd, mcpServers });
  }

  closeSession(sessionId: string): Promise<acp.CloseSessionResponse> {
    return this.agent.request(acp.methods.agent.session.close, { sessionId });
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
  }

  cancel(sessionId: string): Promise<void> {
    return this.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
    return this.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    return this.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    });
  }

  activate(sessionId: string): Promise<unknown> {
    return this.agent.request('alran/session/activate', { sessionId });
  }

  steer(
    sessionId: string,
    text: string,
    clientRequestId?: string,
  ): Promise<{ turnId: string; mode: string }> {
    return this.agent.request('alran/session/steer', {
      sessionId,
      text,
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  }

  getGoal(sessionId: string): Promise<{ goal: unknown }> {
    return this.agent.request('alran/session/goal/get', { sessionId });
  }

  createGoal(sessionId: string, objective: string, tokenBudget?: number | null): Promise<{ goal: unknown }> {
    return this.agent.request('alran/session/goal/create', {
      sessionId,
      objective,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    });
  }

  patchGoal(sessionId: string, patch: GoalPatch): Promise<{ goal: unknown }> {
    return this.agent.request('alran/session/goal/patch', { sessionId, ...patch });
  }

  clearGoal(sessionId: string): Promise<{ cleared: boolean }> {
    return this.agent.request('alran/session/goal/clear', { sessionId });
  }

  getDelegation(sessionId: string): Promise<{ snapshot: DelegationSnapshot }> {
    return this.agent.request('alran/session/delegation/get', { sessionId });
  }

  stopDelegation(sessionId: string): Promise<{ receipt: DelegationStopReceipt }> {
    return this.agent.request('alran/session/delegation/stop', { sessionId });
  }
}

export function isAuthRequired(error: unknown): boolean {
  return (
    error instanceof acp.RequestError
      ? error.code === AUTH_REQUIRED_CODE
      : (error as { code?: unknown } | undefined)?.code === AUTH_REQUIRED_CODE
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
