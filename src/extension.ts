import * as vscode from 'vscode';

import { isInterestingPath } from './core/changes';
import type { AttentionEvent } from './core/session';
import type { ConnectionState, SessionMeta } from './shared/types';
import { AlranCliNotFoundError } from './acp/binary';
import { formatMicroUsd } from './core/account';
import { AccountService, registerAuthenticationProvider, type OttiliAuthenticationProvider } from './host/account';
import { AlranActions } from './host/actions';
import { ChatHub } from './host/chatHub';
import { registerChatParticipant, type AlranChatParticipant } from './host/chatParticipant';
import { registerCommands } from './host/commands';
import { AlranCodeActions } from './host/context';
import { VirtualDocuments } from './host/diff';
import { AlranRuntime } from './host/runtime';
import { SlashRouter } from './host/slash';
import { StoreBrowser } from './host/store';
import { AccountTree, AgentsTree, CapabilitiesTree, ChangesTree, compareVersions, SessionsTree } from './host/trees';

/** The first CLI with the account commands (`alran auth`, `models`, `usage`, `billing`). */
const MIN_CLI_VERSION = '0.9.0';

/** Settings read when the agent process starts. */
const AGENT_SETTINGS = [
  'alran.executablePath',
  'alran.nodePath',
  'alran.env',
  'alran.lane',
  'alran.systemPrompt',
  'alran.systemPromptFile',
  'alran.appendSystemPrompt',
  'alran.appendSystemPromptFile',
  'alran.mcpServers',
];

export interface AlranExtensionApi {
  readonly runtime: AlranRuntime;
  readonly hub: ChatHub;
  readonly actions: AlranActions;
  readonly account: AccountService;
  /** The Plugin Store and Skill Library. */
  readonly store: StoreBrowser;
  /** The Ottili account in the editor's Accounts menu. */
  readonly authProvider: OttiliAuthenticationProvider;
  /** `@alran` in the editor's Chat view, where the editor has one. */
  readonly chatParticipant?: AlranChatParticipant;
  readonly trees: {
    readonly sessions: SessionsTree;
    readonly changes: ChangesTree;
    readonly agents: AgentsTree;
    readonly capabilities: CapabilitiesTree;
    readonly account: AccountTree;
  };
}

export function activate(context: vscode.ExtensionContext): AlranExtensionApi {
  const runtime = new AlranRuntime(context);
  const documents = new VirtualDocuments();
  const hub = new ChatHub(runtime);
  const account = new AccountService(runtime);
  const actions = new AlranActions(runtime, documents, account, {
    focusChat: () => hub.focus(),
    addAttachments: (attachments) => hub.addAttachments(attachments),
    setDraft: (text, send) => hub.setDraft(text, send),
  });
  const sessions = new SessionsTree(runtime);
  const changes = new ChangesTree(runtime);
  const agents = new AgentsTree(runtime);
  const capabilities = new CapabilitiesTree(runtime);
  const store = new StoreBrowser(runtime, actions, documents);
  const accountTree = new AccountTree(runtime, account);
  account.onCredentialsChanged = () => actions.afterAccountChange();
  const chat = registerChatParticipant(runtime, context.extensionUri);
  const auth = registerAuthenticationProvider(account);
  hub.actions = actions;
  hub.account = account;
  hub.router = new SlashRouter(actions, {
    focusCapabilities: async () => {
      await vscode.commands.executeCommand('alran.capabilities.focus');
    },
    focusAgents: async () => {
      await vscode.commands.executeCommand('alran.agents.focus');
    },
  }, store);
  hub.pluginMentions = () => capabilities.pluginMentions();

  context.subscriptions.push(
    runtime,
    documents,
    hub,
    account,
    actions,
    sessions,
    changes,
    agents,
    capabilities,
    store,
    accountTree,
    auth.disposable,
    chat.disposable,
    vscode.window.registerTreeDataProvider('alran.account', accountTree),
    vscode.window.registerTerminalProfileProvider('alran.terminalProfile', {
      provideTerminalProfile: async () => new vscode.TerminalProfile(await runtime.terminalOptions([])),
    }),
    vscode.window.registerWebviewViewProvider(ChatHub.viewId, hub, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider('alran.sessions', sessions),
    vscode.window.registerTreeDataProvider('alran.changes', changes),
    vscode.window.registerTreeDataProvider('alran.agents', agents),
    vscode.window.registerTreeDataProvider('alran.capabilities', capabilities),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new AlranCodeActions(), {
      providedCodeActionKinds: AlranCodeActions.kinds,
    }),
    ...registerCommands({ runtime, actions, hub, account, sessions, changes, agents, capabilities, store }),
    new StatusBar(runtime, account),
    new AttentionNotifier(runtime, hub),
    createChangeWatcher(runtime),
    registerContextKeys(runtime, account),
    warnAboutOldCli(runtime, actions),
    ...checkCliInstalled(context, runtime, actions),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!AGENT_SETTINGS.some((key) => event.affectsConfiguration(key))) return;
      if (runtime.manager.connection.state === 'disconnected') return;
      const reload = 'Reload Agent';
      void vscode.window
        .showInformationMessage('Reload the Alran agent to apply this setting.', reload)
        .then((choice) => {
          if (choice === reload) void actions.guarded(() => actions.restartAgent());
        });
    }),
  );

  // One CLI call at a time at startup: a fresh data directory is migrated by the first one.
  void account
    .refresh()
    .finally(() => capabilities.loadPlugins())
    .catch(() => undefined);
  return {
    runtime,
    hub,
    actions,
    account,
    store,
    authProvider: auth.provider,
    ...(chat.participant ? { chatParticipant: chat.participant } : {}),
    trees: { sessions, changes, agents, capabilities, account: accountTree },
  };
}

export function deactivate(): void {
  // The runtime is disposed through the extension's subscriptions.
}

/** Model, permission, and context usage of the active Session, at a glance. */
class StatusBar implements vscode.Disposable {
  private readonly main = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly model = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  private readonly permission = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  private readonly context = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly runtime: AlranRuntime,
    private readonly account: AccountService,
  ) {
    this.main.command = 'alran.openChat';
    this.main.name = 'Alran Code';
    this.model.name = 'Alran Code: Model';
    this.permission.name = 'Alran Code: Permission Mode';
    this.context.name = 'Alran Code: Context';
    this.model.command = 'alran.pickModel';
    this.permission.command = 'alran.pickPermissionMode';
    this.context.command = 'alran.context';
    this.disposables = [
      runtime.onDidChangeConnection(() => this.render()),
      runtime.onDidChangeMeta(() => this.render()),
      runtime.onDidChangeTabs(() => this.render()),
      account.onDidChange(() => this.render()),
    ];
    this.render();
    this.main.show();
  }

  private tooltip(connection: ConnectionState): vscode.MarkdownString {
    const lines: string[] = ['**Alran Code**'];
    const { status, credits } = this.account.snapshot;
    if (connection.state === 'connected' && connection.version) lines.push(`CLI ${connection.version}`);
    if (connection.state === 'auth-required') lines.push('Not signed in — [Sign in](command:alran.login)');
    if (connection.state === 'missing-binary') lines.push('CLI not found — [Install](command:alran.installCli)');
    if (connection.state === 'error') lines.push('The agent stopped — [Show logs](command:alran.showLogs)');
    if (status?.signedIn) {
      lines.push(`Signed in as ${status.name ?? 'your Ottili account'}${status.companyId ? ` · ${status.companyId}` : ''}`);
      if (credits?.available_microcents !== undefined) {
        lines.push(`Credit: ${formatMicroUsd(credits.available_microcents)} available — [Add credit](command:alran.openBilling)`);
      }
    } else if (status && connection.state !== 'auth-required') {
      lines.push('Ottili account: not signed in — [Sign in](command:alran.login)');
    }
    lines.push('[Open chat](command:alran.openChat) · [Account](command:alran.account.focus) · [Logs](command:alran.showLogs)');
    const markdown = new vscode.MarkdownString(lines.join('\n\n'), true);
    markdown.isTrusted = {
      enabledCommands: ['alran.login', 'alran.installCli', 'alran.showLogs', 'alran.openBilling', 'alran.openChat', 'alran.account.focus'],
    };
    return markdown;
  }

  private render(): void {
    const { manager } = this.runtime;
    const meta = manager.active?.meta;
    this.main.text = this.mainText(manager.connection, meta);
    this.main.tooltip = this.tooltip(manager.connection);
    this.main.backgroundColor =
      manager.connection.state === 'error' || manager.connection.state === 'missing-binary'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : undefined;
    const model = meta?.config.find((option) => option.id === 'model');
    const permission = meta?.config.find((option) => option.id === 'permissionMode');
    this.renderOption(this.model, '$(hubot)', model);
    this.renderOption(this.permission, '$(shield)', permission);
    if (permission?.currentValue === 'bypassPermissions') {
      this.permission.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.permission.backgroundColor = undefined;
    }
    if (meta?.usage && meta.usage.size > 0) {
      this.context.text = `${String(Math.round((meta.usage.used / meta.usage.size) * 100))}%`;
      this.context.tooltip = `${meta.usage.used.toLocaleString()} / ${meta.usage.size.toLocaleString()} context tokens`;
      this.context.show();
    } else {
      this.context.hide();
    }
  }

  private renderOption(
    item: vscode.StatusBarItem,
    icon: string,
    option: SessionMeta['config'][number] | undefined,
  ): void {
    const current = option?.options.find((choice) => choice.value === option.currentValue);
    if (!option || !current) {
      item.hide();
      return;
    }
    item.text = `${icon} ${current.name}`;
    item.tooltip = option.description ?? option.name;
    item.show();
  }

  private mainText(connection: ConnectionState, meta: SessionMeta | undefined): string {
    if (connection.state === 'connecting') return '$(loading~spin) Alran';
    if (connection.state === 'auth-required') return '$(account) Alran: Sign in';
    if (connection.state === 'missing-binary' || connection.state === 'error') return '$(warning) Alran';
    if (meta?.status === 'running' || meta?.status === 'background') return '$(loading~spin) Alran';
    if (meta?.status === 'awaiting-input') return '$(bell-dot) Alran';
    return '$(sparkle) Alran';
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.main.dispose();
    this.model.dispose();
    this.permission.dispose();
    this.context.dispose();
  }
}

/** Mirrors the TUI's `notifications` settings, with a badge for pending decisions. */
class AttentionNotifier implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly runtime: AlranRuntime,
    private readonly hub: ChatHub,
  ) {
    this.disposables = [
      runtime.onDidRequestAttention((event) => this.handle(event)),
      runtime.onDidChangeMeta(() => this.updateBadge()),
      runtime.onDidChangeTabs(() => this.updateBadge()),
    ];
  }

  private updateBadge(): void {
    const waiting = [...this.runtime.manager.sessions.values()].reduce(
      (sum, session) => sum + session.pendingInteractionCount,
      0,
    );
    this.hub.setBadge(waiting);
  }

  private shouldNotify(kind: AttentionEvent['kind']): boolean {
    const config = this.runtime.configuration;
    const when = config.get<'unfocused' | 'always' | 'never'>('notifications.when', 'unfocused');
    if (when === 'never') return false;
    const events = config.get<string[]>('notifications.events', [
      'turn-complete',
      'turn-failed',
      'permission-required',
      'question-required',
    ]);
    const names: Record<AttentionEvent['kind'], string> = {
      'turn-complete': 'turn-complete',
      'turn-failed': 'turn-failed',
      permission: 'permission-required',
      question: 'question-required',
    };
    if (!events.includes(names[kind])) return false;
    return when === 'always' || !vscode.window.state.focused || !this.hub.isVisible;
  }

  private handle(event: AttentionEvent): void {
    if (!this.shouldNotify(event.kind)) return;
    const session = this.runtime.manager.sessions.get(event.sessionId);
    const show = () => {
      this.runtime.manager.setActive(event.sessionId);
      void this.hub.focus();
    };
    if (event.kind === 'permission') {
      const item = event.itemId ? session?.model.find(event.itemId) : undefined;
      const options = item?.kind === 'permission' ? item.options : [];
      const buttons = options.map((option) => option.name);
      void vscode.window
        .showWarningMessage(`Alran needs permission: ${event.title}`, ...buttons, 'Show')
        .then((choice) => {
          if (choice === 'Show') show();
          const option = options.find((candidate) => candidate.name === choice);
          if (option && event.itemId) session?.answerPermission(event.itemId, option.id);
        });
    } else if (event.kind === 'question') {
      void vscode.window.showInformationMessage(`Alran asks: ${event.title}`, 'Answer').then((choice) => {
        if (choice) show();
      });
    } else if (event.kind === 'turn-failed') {
      void vscode.window
        .showErrorMessage(`Alran failed: ${event.detail ?? event.title}`, 'Show')
        .then((choice) => {
          if (choice) show();
        });
    } else {
      void vscode.window.showInformationMessage(`Alran finished: ${event.title}`, 'Show').then((choice) => {
        if (choice) show();
      });
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** Attributes files changed by commands (not edit tools) to the running turn. */
function createChangeWatcher(runtime: AlranRuntime): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const running = new Set<string>();
  const onChange = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file' || running.size === 0 || !isInterestingPath(uri.fsPath)) return;
    for (const sessionId of running) {
      runtime.manager.sessions.get(sessionId)?.noteExternalChange(uri.fsPath);
    }
  };
  const disposables = [
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidDelete(onChange),
    runtime.onDidChangeTurn(({ sessionId, running: isRunning }) => {
      if (isRunning) running.add(sessionId);
      else running.delete(sessionId);
    }),
  ];
  return vscode.Disposable.from(...disposables);
}

function registerContextKeys(runtime: AlranRuntime, account: AccountService): vscode.Disposable {
  const update = () => {
    const status = account.snapshot.status;
    void vscode.commands.executeCommand('setContext', 'alran.signedIn', status?.signedIn === true);
    void vscode.commands.executeCommand(
      'setContext',
      'alran.accountKnown',
      status !== undefined || account.snapshot.error !== undefined,
    );
    const meta = runtime.manager.active?.meta;
    void vscode.commands.executeCommand('setContext', 'alran.hasSession', meta !== undefined);
    void vscode.commands.executeCommand(
      'setContext',
      'alran.running',
      meta?.status === 'running' || meta?.status === 'awaiting-input' || meta?.status === 'cancelling',
    );
    void vscode.commands.executeCommand(
      'setContext',
      'alran.connected',
      runtime.manager.connection.state === 'connected',
    );
  };
  update();
  return vscode.Disposable.from(
    runtime.onDidChangeMeta(update),
    runtime.onDidChangeTabs(update),
    runtime.onDidChangeConnection(update),
    account.onDidChange(update),
  );
}

/** Says once per version when the installed CLI is older than this extension needs. */
function warnAboutOldCli(runtime: AlranRuntime, actions: AlranActions): vscode.Disposable {
  let warned: string | undefined;
  return runtime.onDidChangeConnection((connection) => {
    if (connection.state !== 'connected' || !connection.version || warned === connection.version) return;
    if (compareVersions(connection.version, MIN_CLI_VERSION) >= 0) return;
    warned = connection.version;
    const update = 'Update Alran CLI';
    void vscode.window
      .showWarningMessage(
        `Alran CLI ${connection.version} is older than this extension needs (${MIN_CLI_VERSION}). Sign-in, models, credit, billing and the Plugin Store need the update.`,
        update,
      )
      .then((choice) => {
        if (choice === update) void actions.guarded(() => actions.update());
      });
  });
}

const HIDE_MISSING_CLI_KEY = 'alran.hideMissingCliNotice';

/**
 * The extension is a front end for the Alran CLI and does nothing without it.
 * Say so right after startup, not only when the chat is opened.
 */
function checkCliInstalled(
  context: vscode.ExtensionContext,
  runtime: AlranRuntime,
  actions: AlranActions,
): vscode.Disposable[] {
  const check = async (): Promise<void> => {
    let missing = false;
    try {
      await runtime.resolveCli();
    } catch (error) {
      missing = error instanceof AlranCliNotFoundError;
    }
    void vscode.commands.executeCommand('setContext', 'alran.cliMissing', missing);
    if (!missing || context.globalState.get<boolean>(HIDE_MISSING_CLI_KEY)) return;
    const install = 'Install Alran CLI';
    const locate = 'It Is Installed…';
    const hide = "Don't Show Again";
    const choice = await vscode.window.showWarningMessage(
      'Alran Code needs the Alran CLI on this machine. The extension runs it to do the work.',
      install,
      locate,
      hide,
    );
    if (choice === install || choice === locate) await actions.guarded(() => actions.offerInstall());
    else if (choice === hide) await context.globalState.update(HIDE_MISSING_CLI_KEY, true);
  };
  void check();
  return [
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('alran.executablePath') || event.affectsConfiguration('alran.env')) {
        void context.globalState.update(HIDE_MISSING_CLI_KEY, undefined);
        void check();
      }
    }),
    runtime.onDidChangeConnection((state) => {
      if (state.state === 'connected') void vscode.commands.executeCommand('setContext', 'alran.cliMissing', false);
    }),
  ];
}
