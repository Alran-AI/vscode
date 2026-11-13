import { randomBytes } from 'node:crypto';
import path from 'node:path';

import * as vscode from 'vscode';

import { parseSlash } from '../shared/commands';
import type { HostMessage, QueueOperation, GoalOperation, WebviewMessage } from '../shared/protocol';
import type { ComposerAttachment, MentionCandidate, TranscriptItem } from '../shared/types';
import type { FailureAction } from '../shared/errors';
import type { AccountService } from './account';
import type { AlranActions } from './actions';
import { attachmentsFromUris, fileAttachment, findFileMentions, relativeLabel } from './context';
import { openPermissionPreview, openToolDiff } from './diff';
import type { AlranRuntime } from './runtime';
import type { SlashRouter } from './slash';

const ITEM_FLUSH_MS = 33;

interface ChatSurface {
  readonly webview: vscode.Webview;
  ready: boolean;
}

/** Connects the chat webviews (sidebar and editor tabs) to the Session state. */
export class ChatHub implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'alran.chat';

  private readonly surfaces = new Set<ChatSurface>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingItems = new Map<string, TranscriptItem>();
  private flushTimer: NodeJS.Timeout | undefined;
  private sidebar: vscode.WebviewView | undefined;
  private readonly panels = new Set<vscode.WebviewPanel>();
  private queuedOutbound: HostMessage[] = [];
  actions!: AlranActions;
  router!: SlashRouter;
  private accountListener: vscode.Disposable | undefined;
  private accountService: AccountService | undefined;
  pluginMentions: () => readonly MentionCandidate[] = () => [];

  constructor(private readonly runtime: AlranRuntime) {
    this.disposables.push(
      runtime.onDidChangeConnection((connection) => this.broadcast({ type: 'connection', connection })),
      runtime.onDidChangeTabs(({ tabs, activeId }) =>
        this.broadcast({ type: 'tabs', tabs, ...(activeId ? { activeId } : {}) }),
      ),
      runtime.onDidChangeMeta((meta) => {
        if (meta.id === runtime.manager.activeId) this.broadcast({ type: 'meta', meta });
      }),
      runtime.onDidChangeItems(({ sessionId, items }) => {
        if (sessionId !== runtime.manager.activeId) return;
        for (const item of items) this.pendingItems.set(item.id, item);
        this.flushTimer ??= setTimeout(() => this.flushItems(), ITEM_FLUSH_MS);
      }),
      runtime.onDidReplaceSession((sessionId) => {
        if (!sessionId || sessionId === runtime.manager.activeId) this.sendSnapshot();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveFile()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('alran')) {
          this.broadcast({ type: 'preferences', preferences: runtime.preferences() });
        }
      }),
    );
  }

  set account(service: AccountService) {
    this.accountService = service;
    this.accountListener?.dispose();
    this.accountListener = service.onDidChange(() => this.broadcast({ type: 'account', account: service.view }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebar = view;
    view.webview.options = this.webviewOptions();
    const surface = this.attach(view.webview, 'sidebar');
    view.onDidDispose(() => {
      this.surfaces.delete(surface);
      if (this.sidebar === view) this.sidebar = undefined;
    });
  }

  openInEditor(): void {
    const panel = vscode.window.createWebviewPanel(
      'alran.chatPanel',
      'Alran Code',
      vscode.ViewColumn.Beside,
      { ...this.webviewOptions(), retainContextWhenHidden: true, enableFindWidget: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.runtime.extensionUri, 'media', 'icon.png');
    const surface = this.attach(panel.webview, 'panel');
    this.panels.add(panel);
    panel.onDidDispose(() => {
      this.surfaces.delete(surface);
      this.panels.delete(panel);
    });
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.runtime.extensionUri, 'dist', 'webview')],
    };
  }

  private attach(webview: vscode.Webview, kind: 'sidebar' | 'panel'): ChatSurface {
    const surface: ChatSurface = { webview, ready: false };
    this.surfaces.add(surface);
    webview.html = this.renderHtml(webview, kind);
    webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handle(surface, message);
    });
    return surface;
  }

  private renderHtml(webview: vscode.Webview, kind: 'sidebar' | 'panel'): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.runtime.extensionUri, 'dist', 'webview', file));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${asset('main.css').toString()}" />
<title>Alran Code</title>
</head>
<body data-surface="${kind}">
<div id="app"></div>
<script nonce="${nonce}" src="${asset('main.js').toString()}"></script>
</body>
</html>`;
  }

  private post(surface: ChatSurface, message: HostMessage): void {
    void surface.webview.postMessage(message);
  }

  private broadcast(message: HostMessage): void {
    for (const surface of this.surfaces) if (surface.ready) this.post(surface, message);
  }

  private flushItems(): void {
    this.flushTimer = undefined;
    const sessionId = this.runtime.manager.activeId;
    if (sessionId && this.pendingItems.size > 0) {
      this.broadcast({ type: 'items', sessionId, items: [...this.pendingItems.values()] });
    }
    this.pendingItems.clear();
  }

  private sendSnapshot(): void {
    this.pendingItems.clear();
    this.broadcast({ type: 'snapshot', snapshot: this.runtime.manager.active?.snapshot ?? null });
  }

  private activeFileLabel(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.uri.scheme === 'file' ? relativeLabel(editor.document.uri) : undefined;
  }

  private sendActiveFile(): void {
    const label = this.activeFileLabel();
    this.broadcast({ type: 'activeFile', ...(label ? { label } : {}) });
  }

  addAttachments(attachments: readonly ComposerAttachment[]): void {
    this.deliver({ type: 'addAttachments', attachments });
  }

  setDraft(text: string, send?: boolean): void {
    this.deliver({ type: 'setDraft', text, ...(send ? { send: true } : {}) });
  }

  /** Delivers now, or as soon as a webview finishes loading after a focus request. */
  private deliver(message: HostMessage): void {
    if ([...this.surfaces].some((surface) => surface.ready)) this.broadcast(message);
    else this.queuedOutbound.push(message);
  }

  /** Brings a chat forward: a visible chat editor tab if there is one, else the side bar. */
  async focus(): Promise<void> {
    const panel = [...this.panels].find((candidate) => candidate.visible);
    if (panel) panel.reveal(panel.viewColumn, false);
    else if (this.sidebar) this.sidebar.show(true);
    else await vscode.commands.executeCommand('alran.chat.focus');
    this.broadcast({ type: 'focusComposer' });
  }

  get isVisible(): boolean {
    return this.sidebar?.visible === true || [...this.panels].some((panel) => panel.visible);
  }

  setBadge(count: number): void {
    if (!this.sidebar) return;
    this.sidebar.badge = count > 0 ? { value: count, tooltip: `${String(count)} waiting for you` } : undefined;
  }

  /** Test hook: every webview that finished its handshake. */
  get readySurfaceCount(): number {
    return [...this.surfaces].filter((surface) => surface.ready).length;
  }

  private async handleReady(surface: ChatSurface): Promise<void> {
    surface.ready = true;
    const { manager } = this.runtime;
    this.post(surface, { type: 'preferences', preferences: this.runtime.preferences() });
    this.post(surface, { type: 'connection', connection: manager.connection });
    this.post(surface, {
      type: 'tabs',
      tabs: manager.tabs,
      ...(manager.activeId ? { activeId: manager.activeId } : {}),
    });
    this.post(surface, { type: 'snapshot', snapshot: manager.active?.snapshot ?? null });
    const label = this.activeFileLabel();
    this.post(surface, { type: 'activeFile', ...(label ? { label } : {}) });
    if (this.accountService) this.post(surface, { type: 'account', account: this.accountService.view });
    for (const message of this.queuedOutbound.splice(0)) this.post(surface, message);
    if (this.runtime.configuration.get('autoConnect', true)) {
      // Startup failures are shown by the connection card in the webview.
      await this.runtime.ensureSession().catch((error: unknown) => {
        this.runtime.output.warn(`startup: ${String(error)}`);
      });
    }
  }

  private async handle(surface: ChatSurface, message: WebviewMessage): Promise<void> {
    try {
      await this.dispatch(surface, message);
    } catch (error) {
      await this.actions.reportError(error);
    }
  }

  private async dispatch(surface: ChatSurface, message: WebviewMessage): Promise<void> {
    const { actions } = this;
    const session = this.runtime.manager.active;
    switch (message.type) {
      case 'ready':
        await this.handleReady(surface);
        break;
      case 'send':
        await this.handleSend(message);
        break;
      case 'cancel':
        await actions.cancel();
        break;
      case 'retry':
        await actions.retry();
        break;
      case 'newSession':
        await actions.newSession();
        break;
      case 'activateTab':
        this.runtime.manager.setActive(message.id);
        break;
      case 'closeTab':
        await actions.closeTab(message.id);
        break;
      case 'setMode':
        await session?.setMode(message.modeId);
        break;
      case 'setConfig':
        await actions.setConfig(message.configId, message.value);
        break;
      case 'cycleMode':
        await actions.cycleMode();
        break;
      case 'cyclePermission':
        await actions.cyclePermission();
        break;
      case 'permission':
        session?.answerPermission(message.id, message.optionId);
        break;
      case 'question':
        session?.answerQuestion(message.id, message.action, message.content);
        break;
      case 'mentionQuery':
        this.post(surface, {
          type: 'mentions',
          requestId: message.requestId,
          candidates: [
            ...this.pluginMentions().filter((plugin) =>
              plugin.label.toLowerCase().includes(message.query.toLowerCase()),
            ),
            ...(await findFileMentions(message.query)),
          ],
        });
        break;
      case 'pickAttachment': {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
        if (uris) this.post(surface, { type: 'addAttachments', attachments: await attachmentsFromUris(uris) });
        break;
      }
      case 'openFile':
        await this.openFile(message.path, message.line);
        break;
      case 'openToolDiff': {
        const tool = session?.model.findTool(message.toolId);
        if (session && tool) await openToolDiff(actions.documents, session, tool);
        break;
      }
      case 'previewPermissionDiff': {
        const item = session?.model.find(message.id);
        if (item?.kind === 'permission' && !(await openPermissionPreview(actions.documents, item))) {
          void vscode.window.showInformationMessage('No file preview is available for this request.');
        }
        break;
      }
      case 'openPlan':
        await actions.openPlan(message.id);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage('Copied', 1_500);
        break;
      case 'insertAtCursor':
        await this.insertAtCursor(message.text);
        break;
      case 'applyToNewFile':
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument({
            content: message.text,
            ...(message.language ? { language: message.language } : {}),
          }),
        );
        break;
      case 'runInTerminal':
        (vscode.window.activeTerminal ?? vscode.window.createTerminal('Alran')).show();
        // Left unexecuted on purpose: the user presses Enter after reading it.
        vscode.window.activeTerminal?.sendText(message.text, false);
        break;
      case 'queue':
        await this.applyQueue(message.operation);
        break;
      case 'goal':
        await this.applyGoal(message.operation);
        break;
      case 'stopDelegation':
        await session?.stopDelegation();
        break;
      case 'openSubagent':
        await actions.openSession(message.sessionId, session?.meta.cwd ?? this.runtime.defaultCwd());
        break;
      case 'signIn':
        if (message.method === 'options') await this.accountService?.signInOptions();
        else if (message.method === 'api-key') await this.accountService?.signInWithApiKey();
        else if (message.method === 'provider') await vscode.commands.executeCommand('alran.providerAdd');
        else await actions.login();
        break;
      case 'failureAction':
        await this.runFailureAction(message.action);
        break;
      case 'command':
        // The transcript renders model output, so the webview only reaches our own commands.
        if (message.command.startsWith('alran.')) {
          await vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        }
        break;
    }
  }

  private async runFailureAction(action: FailureAction): Promise<void> {
    const { actions } = this;
    switch (action) {
      case 'retry':
        await actions.retry();
        break;
      case 'sign-in':
        await actions.login();
        break;
      case 'add-credits':
        await this.accountService?.openBilling();
        break;
      case 'show-usage':
        await vscode.commands.executeCommand('alran.account.focus');
        await this.accountService?.refresh({ usage: true });
        break;
      case 'switch-model':
        await actions.pickModel();
        break;
      case 'use-werk':
        await actions.useWerk();
        break;
      case 'provider-settings':
        await vscode.commands.executeCommand('alran.capabilities.focus');
        break;
      case 'compact':
        await actions.agentCommand('compact');
        break;
      case 'new-session':
        await actions.newSession();
        break;
      case 'show-logs':
        this.runtime.output.show();
        break;
    }
  }

  private async handleSend(message: Extract<WebviewMessage, { type: 'send' }>): Promise<void> {
    const slash = parseSlash(message.text);
    if (slash && message.attachments.length === 0 && (await this.router.dispatch(slash))) return;
    const session = await this.runtime.ensureSession();
    const attachments = [...message.attachments];
    const editor = vscode.window.activeTextEditor;
    if (
      message.includeActiveFile &&
      !slash &&
      editor?.document.uri.scheme === 'file' &&
      !attachments.some((item) => item.kind === 'file' && item.path === editor.document.uri.fsPath)
    ) {
      attachments.push(fileAttachment(editor.document.uri));
    }
    void session.submit(
      { text: message.text, attachments },
      message.alternate ? { alternate: true } : {},
    );
  }

  private async applyQueue(operation: QueueOperation): Promise<void> {
    const session = this.runtime.manager.active;
    if (!session) return;
    switch (operation.op) {
      case 'delete':
        session.deleteQueued(operation.id);
        break;
      case 'edit':
        session.editQueued(operation.id, operation.text);
        break;
      case 'steer':
        await session.sendQueuedNow(operation.id);
        break;
      case 'clear':
        session.clearQueue();
        break;
    }
  }

  private async applyGoal(operation: GoalOperation): Promise<void> {
    const session = this.runtime.manager.active;
    if (!session) return;
    switch (operation.op) {
      case 'create':
        await session.goalCreate(operation.objective, operation.tokenBudget);
        break;
      case 'pause':
        await session.goalPatch({ status: 'paused' });
        break;
      case 'resume':
        await session.goalPatch({ status: 'active' });
        break;
      case 'edit':
        await session.goalPatch({ objective: operation.objective });
        break;
      case 'budget':
        await session.goalPatch({ tokenBudget: operation.tokenBudget });
        break;
      case 'clear':
        await session.goalClear();
        break;
    }
  }

  private async openFile(filePath: string, line?: number): Promise<void> {
    const cwd = this.runtime.manager.active?.meta.cwd ?? this.runtime.defaultCwd();
    const uri = vscode.Uri.file(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath));
    const editor = await vscode.window.showTextDocument(uri, { preview: true });
    if (line !== undefined) {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async insertAtCursor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file to insert this code.');
      return;
    }
    await editor.insertSnippet(new vscode.SnippetString().appendText(text));
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    this.accountListener?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
