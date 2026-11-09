import * as vscode from 'vscode';

import { isInterestingPath } from './core/changes';
import type { AttentionEvent } from './core/session';
import type { ConnectionState, SessionMeta } from './shared/types';
import { AlranActions } from './host/actions';
import { ChatHub } from './host/chatHub';
import { registerCommands } from './host/commands';
import { AlranCodeActions } from './host/context';
import { VirtualDocuments } from './host/diff';
import { AlranRuntime } from './host/runtime';
import { SlashRouter } from './host/slash';
import { AgentsTree, CapabilitiesTree, ChangesTree, SessionsTree } from './host/trees';

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
  readonly trees: {
    readonly sessions: SessionsTree;
    readonly changes: ChangesTree;
    readonly agents: AgentsTree;
    readonly capabilities: CapabilitiesTree;
  };
}

export function activate(context: vscode.ExtensionContext): AlranExtensionApi {
  const runtime = new AlranRuntime(context);
  const documents = new VirtualDocuments();
  const hub = new ChatHub(runtime);
  const actions = new AlranActions(runtime, documents, {
    focusChat: () => hub.focus(),
    addAttachments: (attachments) => hub.addAttachments(attachments),
    setDraft: (text, send) => hub.setDraft(text, send),
  });
  const sessions = new SessionsTree(runtime);
  const changes = new ChangesTree(runtime);
  const agents = new AgentsTree(runtime);
  const capabilities = new CapabilitiesTree(runtime);
  hub.actions = actions;
  hub.router = new SlashRouter(actions, {
    focusCapabilities: async () => {
      await vscode.commands.executeCommand('alran.capabilities.focus');
    },
    focusAgents: async () => {
      await vscode.commands.executeCommand('alran.agents.focus');
    },
  });
  hub.pluginMentions = () => capabilities.pluginMentions();

  context.subscriptions.push(
    runtime,
    documents,
    hub,
    actions,
    sessions,
    changes,
    agents,
    capabilities,
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
    ...registerCommands({ runtime, actions, hub, sessions, changes, agents, capabilities }),
    new StatusBar(runtime),
    new AttentionNotifier(runtime, hub),
    createChangeWatcher(runtime),
    registerContextKeys(runtime),
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

  void capabilities.loadPlugins().catch(() => undefined);
  return { runtime, hub, actions, trees: { sessions, changes, agents, capabilities } };
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

  constructor(private readonly runtime: AlranRuntime) {
    this.main.command = 'alran.openChat';
    this.model.command = 'alran.pickModel';
    this.permission.command = 'alran.pickPermissionMode';
    this.context.command = 'alran.context';
    this.disposables = [
      runtime.onDidChangeConnection(() => this.render()),
      runtime.onDidChangeMeta(() => this.render()),
      runtime.onDidChangeTabs(() => this.render()),
    ];
    this.render();
    this.main.show();
  }

  private render(): void {
    const { manager } = this.runtime;
    const meta = manager.active?.meta;
    this.main.text = this.mainText(manager.connection, meta);
    this.main.tooltip = 'Open the Alran Code chat';
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

function registerContextKeys(runtime: AlranRuntime): vscode.Disposable {
  const update = () => {
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
  );
}
