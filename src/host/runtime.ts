import { homedir } from 'node:os';
import path from 'node:path';

import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';

import { AlranAgent } from '../acp/agent';
import { readLoginShellPath, resolveAlranCli, spawnCommand, type ResolvedCli } from '../acp/binary';
import type { CliContext } from '../core/cli';
import { AuthRequiredError, SessionManager, type ManagerListener } from '../core/manager';
import type { AttentionEvent, SessionController } from '../core/session';
import type { ChatPreferences, ConnectionState, SessionMeta, TabView, TranscriptItem } from '../shared/types';

const OPEN_SESSIONS_KEY = 'alran.openSessions';

interface PersistedTab {
  readonly id: string;
  readonly cwd: string;
  readonly title?: string;
}

interface PersistedTabs {
  readonly tabs: readonly PersistedTab[];
  readonly activeId?: string;
}

/** Extension-host owner of the agent, its configuration, and its change events. */
export class AlranRuntime implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('Alran Code', { log: true });
  private readonly connectionEmitter = new vscode.EventEmitter<ConnectionState>();
  private readonly tabsEmitter = new vscode.EventEmitter<{
    readonly tabs: readonly TabView[];
    readonly activeId: string | undefined;
  }>();
  private readonly itemsEmitter = new vscode.EventEmitter<{
    readonly sessionId: string;
    readonly items: readonly TranscriptItem[];
  }>();
  private readonly metaEmitter = new vscode.EventEmitter<SessionMeta>();
  private readonly snapshotEmitter = new vscode.EventEmitter<string>();
  private readonly changesEmitter = new vscode.EventEmitter<string>();
  private readonly attentionEmitter = new vscode.EventEmitter<AttentionEvent>();
  private readonly turnEmitter = new vscode.EventEmitter<{
    readonly sessionId: string;
    readonly running: boolean;
  }>();

  readonly onDidChangeConnection = this.connectionEmitter.event;
  readonly onDidChangeTabs = this.tabsEmitter.event;
  readonly onDidChangeItems = this.itemsEmitter.event;
  readonly onDidChangeMeta = this.metaEmitter.event;
  readonly onDidReplaceSession = this.snapshotEmitter.event;
  readonly onDidChangeFiles = this.changesEmitter.event;
  readonly onDidRequestAttention = this.attentionEmitter.event;
  readonly onDidChangeTurn = this.turnEmitter.event;

  readonly manager: SessionManager;
  private loginShellPath: Promise<string | undefined> | undefined;
  private restoring: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const listener: ManagerListener = {
      connection: (state) => {
        this.output.info(`connection: ${state.state}`);
        this.connectionEmitter.fire(state);
      },
      tabs: (tabs, activeId) => {
        this.tabsEmitter.fire({ tabs, activeId });
        this.persistTabs();
      },
      items: (sessionId, items) => this.itemsEmitter.fire({ sessionId, items }),
      meta: (meta) => this.metaEmitter.fire(meta),
      snapshot: (sessionId) => this.snapshotEmitter.fire(sessionId),
      changes: (sessionId) => this.changesEmitter.fire(sessionId),
      attention: (event) => this.attentionEmitter.fire(event),
      turn: (sessionId, running) => this.turnEmitter.fire({ sessionId, running }),
      log: (line) => this.output.debug(line),
    };
    this.manager = new SessionManager(
      {
        createAgent: async (handlers) => {
          const cli = await this.resolveCli();
          this.output.info(`starting ${cli.displayPath} (found via ${cli.source})`);
          return new AlranAgent(
            {
              cli,
              cwd: this.defaultCwd(),
              env: await this.environment(),
              globalArgs: this.globalArgs(),
              acpArgs: this.systemPromptArgs(),
              clientVersion: this.extensionVersion,
            },
            handlers,
          );
        },
        mcpServers: () => this.mcpServers(),
        enterWhileRunning: () => this.preferences().enterWhileRunning,
      },
      listener,
    );
  }

  get extensionVersion(): string {
    return (this.context.extension.packageJSON as { version: string }).version;
  }

  get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  get configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('alran');
  }

  preferences(): ChatPreferences {
    const config = this.configuration;
    return {
      enterWhileRunning: config.get<'steer' | 'queue'>('chat.enterWhileRunning', 'steer'),
      showThinking: config.get('chat.showThinking', true),
      includeActiveFile: config.get('context.includeActiveFile', true),
      sendShortcut: config.get<'enter' | 'ctrlEnter'>('chat.sendShortcut', 'enter'),
    };
  }

  private async pathFromLoginShell(): Promise<string | undefined> {
    this.loginShellPath ??= readLoginShellPath(process.env);
    return this.loginShellPath;
  }

  resolveCli(): Promise<ResolvedCli> {
    return (async () =>
      resolveAlranCli({
        configuredPath: this.configuration.get('executablePath', ''),
        nodePath: this.configuration.get('nodePath', ''),
        env: await this.environment(),
        loginShellPath: () => this.pathFromLoginShell(),
      }))();
  }

  /** Inherited environment, with the login-shell PATH and user overrides applied. */
  async environment(): Promise<NodeJS.ProcessEnv> {
    const shellPath = await this.pathFromLoginShell();
    const separator = process.platform === 'win32' ? ';' : ':';
    const merged = [
      ...new Set([...(process.env.PATH ?? '').split(separator), ...(shellPath ?? '').split(separator)]),
    ]
      .filter(Boolean)
      .join(separator);
    return {
      ...process.env,
      PATH: merged,
      ...this.configuration.get<Record<string, string>>('env', {}),
    };
  }

  globalArgs(): string[] {
    const lane = this.configuration.get<string>('lane', '').trim();
    return lane ? ['--lane', lane] : [];
  }

  systemPromptArgs(): string[] {
    const config = this.configuration;
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['--system-prompt', 'systemPrompt'],
      ['--system-prompt-file', 'systemPromptFile'],
      ['--append-system-prompt', 'appendSystemPrompt'],
      ['--append-system-prompt-file', 'appendSystemPromptFile'],
    ];
    return pairs.flatMap(([flag, key]) => {
      const value = config.get<string>(key, '').trim();
      return value ? [flag, value] : [];
    });
  }

  mcpServers(): acp.McpServer[] {
    return this.configuration.get<acp.McpServer[]>('mcpServers', []);
  }

  async cliContext(): Promise<CliContext> {
    return {
      cli: await this.resolveCli(),
      cwd: this.defaultCwd(),
      env: await this.environment(),
      globalArgs: this.globalArgs(),
    };
  }

  /** Terminal launch parameters for an interactive `alran` command. */
  async terminalOptions(args: readonly string[], cwd?: string): Promise<vscode.TerminalOptions> {
    const cli = await this.resolveCli();
    const spec = spawnCommand(cli, [...this.globalArgs(), ...args]);
    const env = await this.environment();
    return {
      name: 'Alran Code',
      cwd: cwd ?? this.defaultCwd(),
      shellPath: spec.command,
      shellArgs: [...spec.args],
      env: env as Record<string, string>,
      iconPath: new vscode.ThemeIcon('sparkle'),
    };
  }

  /** Alran's data directory (`ALRAN_DATA_DIR`, else `~/.alran`). */
  dataDir(): string {
    const env = this.configuration.get<Record<string, string>>('env', {});
    return env.ALRAN_DATA_DIR || process.env.ALRAN_DATA_DIR || path.join(homedir(), '.alran');
  }

  defaultCwd(): string {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    return (
      activeFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir()
    );
  }

  /** The active Session, creating or restoring one when nothing is open. */
  async ensureSession(): Promise<SessionController> {
    await this.restoreTabs();
    return this.manager.active ?? (await this.manager.newSession(this.defaultCwd()));
  }

  /** Reopens the tabs this window had when it was last closed. */
  restoreTabs(): Promise<void> {
    this.restoring ??= this.doRestoreTabs();
    return this.restoring;
  }

  private async doRestoreTabs(): Promise<void> {
    const saved = this.context.workspaceState.get<PersistedTabs>(OPEN_SESSIONS_KEY);
    if (!saved?.tabs.length) return;
    for (const tab of saved.tabs) {
      try {
        await this.manager.openSession(tab.id, tab.cwd, tab.title);
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          // Retry the whole restore after the user signs in.
          this.restoring = undefined;
          throw error;
        }
        this.output.warn(`could not reopen session ${tab.id}: ${String(error)}`);
      }
    }
    if (saved.activeId && this.manager.sessions.has(saved.activeId)) {
      this.manager.setActive(saved.activeId);
    }
  }

  private persistTabs(): void {
    const tabs: PersistedTab[] = [...this.manager.sessions.values()]
      .filter((session) => !session.meta.isSide)
      .map((session) => ({
        id: session.id,
        cwd: session.meta.cwd,
        ...(session.meta.title ? { title: session.meta.title } : {}),
      }));
    void this.context.workspaceState.update(OPEN_SESSIONS_KEY, {
      tabs,
      ...(this.manager.activeId ? { activeId: this.manager.activeId } : {}),
    } satisfies PersistedTabs);
  }

  dispose(): void {
    void this.manager.dispose();
    this.output.dispose();
    this.connectionEmitter.dispose();
    this.tabsEmitter.dispose();
    this.itemsEmitter.dispose();
    this.metaEmitter.dispose();
    this.snapshotEmitter.dispose();
    this.changesEmitter.dispose();
    this.attentionEmitter.dispose();
    this.turnEmitter.dispose();
  }
}
