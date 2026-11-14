import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import * as vscode from 'vscode';

import { errorMessage } from '../acp/agent';
import { AlranCliNotFoundError } from '../acp/binary';
import { formatModelPrice, modelKeyFromConfigValue } from '../core/account';
import { AlranCliError } from '../core/cli';
import { AuthRequiredError } from '../core/manager';
import type { SessionController } from '../core/session';
import { parseGoalArgs } from '../shared/commands';
import { transcriptToMarkdown } from '../shared/markdown';
import type { ComposerAttachment, ConfigOptionView, PromptInput } from '../shared/types';
import { availabilityLabel, openExternalUrl, type AccountService } from './account';
import { VirtualDocuments } from './diff';
import type { AlranRuntime } from './runtime';

export const REVIEW_PROMPT = 'Please review my uncommitted changes.';
export const INSTALL_SCRIPT = 'curl -fsSL https://alran.dev/install.sh | bash';
export const INSTALL_NPM = 'npm install -g alran';
export const INSTALL_GUIDE_URL = 'https://alran.dev/en/docs/install';
const FULL_ACCESS = 'bypassPermissions';

/** Everything the chat, the command palette, and the slash router can do. */
export class AlranActions {
  private readonly terminalReattach = new Map<vscode.Terminal, string>();
  private readonly closeListener: vscode.Disposable;

  constructor(
    readonly runtime: AlranRuntime,
    readonly documents: VirtualDocuments,
    readonly account: AccountService,
    private readonly hooks: {
      readonly focusChat: () => Promise<void>;
      readonly addAttachments: (attachments: readonly ComposerAttachment[]) => void;
      readonly setDraft: (text: string, send?: boolean) => void;
    },
  ) {
    this.closeListener = vscode.window.onDidCloseTerminal((terminal) => {
      const sessionId = this.terminalReattach.get(terminal);
      if (!sessionId) return;
      this.terminalReattach.delete(terminal);
      void this.reattachAfterTui(sessionId);
    });
  }

  dispose(): void {
    this.closeListener.dispose();
  }

  get active(): SessionController | undefined {
    return this.runtime.manager.active;
  }

  private notify(message: string, level: 'info' | 'warning' = 'info'): void {
    if (this.active) this.active.pushNotice(level, message);
    else void vscode.window.showInformationMessage(message);
  }

  /** Runs a user-triggered operation and turns failures into guidance. */
  async guarded(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      await this.reportError(error);
    }
  }

  async reportError(error: unknown): Promise<void> {
    if (error instanceof AlranCliNotFoundError) {
      await this.offerInstall();
      return;
    }
    if (error instanceof AuthRequiredError || (error instanceof AlranCliError && error.kind === 'auth')) {
      const signIn = 'Sign In';
      const options = 'Other Options…';
      const choice = await vscode.window.showWarningMessage(
        error instanceof AuthRequiredError
          ? 'Sign in to Alran Code to continue.'
          : 'Your Ottili session has ended. Sign in again to continue.',
        signIn,
        options,
      );
      if (choice === signIn) await this.login();
      else if (choice === options) await this.account.signInOptions();
      return;
    }
    const message = errorMessage(error);
    this.runtime.output.error(message);
    if (error instanceof AlranCliError && error.kind === 'credits') {
      const add = 'Add Credits';
      if ((await vscode.window.showWarningMessage(message, add)) === add) await this.account.openBilling();
      return;
    }
    if (error instanceof AlranCliError && (error.kind === 'offline' || error.kind === 'rate-limit' || error.kind === 'timeout')) {
      void vscode.window.showWarningMessage(message);
      return;
    }
    void vscode.window.showErrorMessage(`Alran Code: ${message}`, 'Show Logs').then((choice) => {
      if (choice === 'Show Logs') this.runtime.output.show();
    });
  }

  async offerInstall(): Promise<void> {
    type Choice = vscode.QuickPickItem & { readonly id: 'script' | 'npm' | 'path' | 'guide' };
    const items: Choice[] = [
      ...(process.platform === 'win32'
        ? []
        : [
            {
              id: 'script' as const,
              label: '$(terminal) Install with the official script',
              description: 'Recommended',
              detail: `${INSTALL_SCRIPT} — installs Alran and a managed Node.js into ~/.alran-code`,
            },
          ]),
      {
        id: 'npm',
        label: '$(package) Install with npm',
        description: process.platform === 'win32' ? 'Recommended on Windows' : '',
        detail: `${INSTALL_NPM} — needs Node.js 22.19 or newer`,
      },
      {
        id: 'path',
        label: '$(folder-opened) Use an existing installation…',
        detail: 'Point the "alran.executablePath" setting at the alran command or its cli.js.',
      },
      { id: 'guide', label: '$(book) Open the installation guide', detail: INSTALL_GUIDE_URL },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Install the Alran Code CLI',
      placeHolder: 'The extension runs the alran command on this machine. It was not found.',
      ignoreFocusOut: true,
    });
    if (!picked) return;
    if (picked.id === 'guide') {
      await openExternalUrl(INSTALL_GUIDE_URL);
      return;
    }
    if (picked.id === 'path') {
      await this.locateCli();
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: 'Install Alran Code',
      iconPath: new vscode.ThemeIcon('cloud-download'),
    });
    terminal.show();
    terminal.sendText(picked.id === 'script' ? INSTALL_SCRIPT : INSTALL_NPM);
    const listener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      listener.dispose();
      void this.guarded(async () => {
        await this.restartAgent();
        await this.account.refresh();
      });
    });
    void vscode.window
      .showInformationMessage(
        'Installing the Alran CLI in the terminal. When it has finished, reload the agent.',
        'Reload Agent',
      )
      .then((choice) => {
        if (choice === 'Reload Agent') void this.guarded(() => this.restartAgent());
      });
  }

  private async locateCli(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: 'Select the alran command or its cli.js',
      canSelectMany: false,
      openLabel: 'Use This CLI',
    });
    const file = picked?.[0];
    if (!file) return;
    await this.runtime.configuration.update('executablePath', file.fsPath, vscode.ConfigurationTarget.Global);
    await this.restartAgent();
    await this.account.refresh();
  }

  // Sessions ----------------------------------------------------------------

  async newSession(): Promise<void> {
    await this.hooks.focusChat();
    await this.runtime.manager.newSession(await this.pickCwd());
    await this.hooks.focusChat();
  }

  private async pickCwd(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) return this.runtime.defaultCwd();
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Workspace folder for the new Alran session',
    });
    return picked?.uri.fsPath ?? this.runtime.defaultCwd();
  }

  async pickSession(query = ''): Promise<void> {
    const manager = this.runtime.manager;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lists = folders.length
      ? await Promise.all(folders.map((folder) => manager.listSessions(folder.uri.fsPath)))
      : [await manager.listSessions()];
    const needle = query.toLowerCase();
    const items = lists
      .flat()
      .filter((session) => session.title && session.title.toLowerCase().includes(needle))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .map((session) => ({
        label: session.title ?? session.sessionId,
        description: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '',
        detail: session.cwd,
        session,
      }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage('No previous Alran sessions were found here.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Resume an Alran session',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    await this.openSession(picked.session.sessionId, picked.session.cwd, picked.session.title);
  }

  async openSession(id: string, cwd: string, title?: string): Promise<void> {
    await this.hooks.focusChat();
    await this.runtime.manager.openSession(id, cwd, title);
  }

  async fork(sessionId = this.active?.id): Promise<void> {
    if (!sessionId) return;
    await this.runtime.manager.forkSession(sessionId);
    await this.hooks.focusChat();
  }

  /** `/btw`: a forked side conversation; the main turn keeps running. */
  async sideQuestion(question: string): Promise<void> {
    const source = this.active;
    if (!source) return;
    const side = await this.runtime.manager.forkSession(source.id, { side: true });
    this.sideParents.set(side.id, source.id);
    await this.hooks.focusChat();
    if (question) void side.submit({ text: question, attachments: [] });
  }

  private readonly sideParents = new Map<string, string>();

  async returnToParent(): Promise<void> {
    const side = this.active;
    if (!side) return;
    const parent = this.sideParents.get(side.id);
    if (!parent) {
      this.notify('This Session has no parent.', 'warning');
      return;
    }
    this.runtime.manager.setActive(parent);
    await this.runtime.manager.closeSession(side.id);
    this.sideParents.delete(side.id);
  }

  async closeTab(id = this.active?.id): Promise<void> {
    if (id) await this.runtime.manager.closeSession(id);
  }

  async cancel(): Promise<void> {
    await this.active?.cancel();
  }

  async retry(): Promise<void> {
    await this.active?.retry();
  }

  // Controls ----------------------------------------------------------------

  private findConfig(id: string): ConfigOptionView | undefined {
    return this.active?.meta.config.find((option) => option.id === id);
  }

  async setConfig(configId: string, value: string): Promise<void> {
    const session = this.active;
    if (!session) return;
    if (configId === 'permissionMode' && value === FULL_ACCESS && !(await this.confirmFullAccess())) {
      session.pushNotice('info', 'Permission mode unchanged.');
      this.runtime.manager.setActive(session.id);
      return;
    }
    await session.setConfigOption(configId, value);
  }

  private async confirmFullAccess(): Promise<boolean> {
    if (!this.runtime.userSetting('confirmFullAccess', true)) return true;
    const confirm = 'Enable Full Access';
    const choice = await vscode.window.showWarningMessage(
      'Full Access lets Alran run every tool, including shell commands and file changes, without asking.',
      { modal: true },
      confirm,
    );
    return choice === confirm;
  }

  async pickConfig(configId: string): Promise<void> {
    await this.runtime.ensureSession();
    if (configId === 'model') {
      await this.pickModel();
      return;
    }
    const option = this.findConfig(configId);
    if (!option) {
      void vscode.window.showInformationMessage(`${configId} is not available for this session.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      option.options.map((choice) => ({
        label: `${choice.value === option.currentValue ? '$(check) ' : ''}${choice.name}`,
        value: choice.value,
      })),
      { title: option.name, placeHolder: option.description ?? option.name },
    );
    if (picked) await this.setConfig(configId, picked.value);
  }

  /** The session's models, with the Ottili price and whether the credit covers each. */
  async pickModel(): Promise<void> {
    const session = await this.runtime.ensureSession();
    const option = this.findConfig('model');
    if (!option) {
      void vscode.window.showInformationMessage('This session offers no model choice.');
      return;
    }
    if (!this.account.snapshot.models) await this.account.refresh({ usage: true });
    const catalog = new Map((this.account.snapshot.models ?? []).map((model) => [model.key, model]));
    const makeDefault: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('star-empty'),
      tooltip: 'Make this the default for new sessions',
    };
    type Item = vscode.QuickPickItem & { readonly value?: string };
    const ottili: Item[] = [];
    const others: Item[] = [];
    for (const choice of option.options) {
      const key = modelKeyFromConfigValue(choice.value);
      const model = key ? catalog.get(key) : undefined;
      const current = choice.value === option.currentValue;
      const item: Item = {
        // The agent's name carries the variant ("Ottili Werk 1.1 · thinking").
        label: `${current ? '$(check) ' : ''}${choice.name}`,
        description: model ? formatModelPrice(model) : key?.split('/')[0],
        ...(model
          ? {
              detail: `${model.status === 'available' ? '$(pass)' : model.status === 'sign in to check' ? '$(info)' : '$(warning)'} ${availabilityLabel(model)}${model.default ? ' · default for new sessions' : ''}`,
              buttons: model.default ? [] : [makeDefault],
            }
          : {}),
        value: choice.value,
      };
      (model ? ottili : others).push(item);
    }
    const quickPick = vscode.window.createQuickPick<Item>();
    quickPick.title = 'Model for this session';
    quickPick.placeholder = 'Changes apply from the next message. The star makes a model the default.';
    quickPick.matchOnDescription = true;
    quickPick.items = [
      ...(ottili.length ? [{ label: 'Ottili AI Gateway', kind: vscode.QuickPickItemKind.Separator }, ...ottili] : []),
      ...(others.length ? [{ label: 'Your providers', kind: vscode.QuickPickItemKind.Separator }, ...others] : []),
    ];
    quickPick.activeItems = quickPick.items.filter((item) => item.value === option.currentValue);
    const picked = await new Promise<Item | undefined>((resolve) => {
      quickPick.onDidTriggerItemButton(({ item }) => {
        const key = item.value ? modelKeyFromConfigValue(item.value) : undefined;
        const model = key ? catalog.get(key) : undefined;
        if (model) void this.guarded(() => this.account.setDefaultModel(model));
      });
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.show();
    });
    quickPick.dispose();
    if (!picked?.value || picked.value === option.currentValue) return;
    const key = modelKeyFromConfigValue(picked.value);
    const model = key ? catalog.get(key) : undefined;
    if (model && model.status !== 'available' && model.status !== 'sign in to check') {
      const add = 'Add Credits';
      const anyway = 'Use It Anyway';
      const choice = await vscode.window.showWarningMessage(
        `${model.name}: ${availabilityLabel(model)}.`,
        {
          modal: true,
          detail:
            model.status === 'requires purchased credit'
              ? 'Welcome credit covers Ottili Werk. Claude models are paid with purchased credit; requests without it are refused.'
              : 'Requests to this model are refused until you add credit.',
        },
        add,
        anyway,
      );
      if (choice === add) {
        await this.account.openBilling();
        return;
      }
      if (choice !== anyway) return;
    }
    await session.setConfigOption('model', picked.value);
  }

  /** Switches the active session to Ottili Werk, which welcome credit covers. */
  async useWerk(sessionId?: string): Promise<void> {
    if (sessionId && this.runtime.manager.sessions.has(sessionId)) this.runtime.manager.setActive(sessionId);
    const option = this.findConfig('model');
    const werk = option?.options.find((choice) => modelKeyFromConfigValue(choice.value) === 'alran/Alran-Werk');
    if (!werk) {
      await this.pickModel();
      return;
    }
    await this.active?.setConfigOption('model', werk.value);
    this.notify('Switched to Ottili Werk. Send the message again to continue.');
  }

  async cyclePermission(): Promise<void> {
    const option = this.findConfig('permissionMode');
    if (!option || option.options.length === 0) return;
    const index = option.options.findIndex((choice) => choice.value === option.currentValue);
    const next = option.options[(index + 1) % option.options.length];
    if (next) await this.setConfig(option.id, next.value);
  }

  async cycleMode(): Promise<void> {
    const session = this.active;
    if (!session || session.meta.modes.length < 2) return;
    const current = session.meta.pendingModeId ?? session.meta.currentModeId;
    const next = session.meta.modes.find((mode) => mode.id !== current);
    if (next) await session.setMode(next.id);
  }

  async plan(args: string): Promise<void> {
    const session = await this.runtime.ensureSession();
    const action = args.trim().toLowerCase();
    if (!action) await this.cycleMode();
    else if (action === 'on' || action === 'plan') await session.setMode('plan');
    else if (action === 'off' || action === 'default') await session.setMode('default');
    else if (action === 'status') {
      session.pushNotice('info', `Mode: ${session.meta.pendingModeId ?? session.meta.currentModeId ?? 'default'}`);
    } else if (action === 'view') await this.viewLatestPlan();
    else session.pushNotice('warning', 'Usage: /plan [on | off | status | view]');
  }

  async viewLatestPlan(): Promise<void> {
    const plans = (this.active?.model.items ?? []).filter((item) => item.kind === 'plan');
    const latest = plans[plans.length - 1];
    if (latest?.kind === 'plan') await this.openPlan(latest.id);
    else this.notify('No Plan has been written in this Session yet.');
  }

  async openPlan(id: string): Promise<void> {
    const item = this.active?.model.find(id);
    if (item?.kind !== 'plan') return;
    const content =
      item.markdown ??
      (item.entries ?? []).map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`).join('\n');
    const document = await vscode.workspace.openTextDocument(this.documents.create('plan.md', content));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async permissionCommand(args: string): Promise<void> {
    await this.runtime.ensureSession();
    const action = args.trim().toLowerCase();
    const option = this.findConfig('permissionMode');
    if (!action) await this.pickConfig('permissionMode');
    else if (action === 'status') {
      const current = option?.options.find((choice) => choice.value === option.currentValue);
      this.notify(`Permission mode: ${current?.name ?? 'unknown'}`);
    } else {
      const values: Record<string, string> = { ask: 'default', auto: 'auto', full: FULL_ACCESS };
      const value = values[action];
      if (value) await this.setConfig('permissionMode', value);
      else this.notify('Usage: /permission [status | ask | auto | full]', 'warning');
    }
  }

  async goal(args: string): Promise<void> {
    const session = await this.runtime.ensureSession();
    if (!session.meta.goalsEnabled) {
      session.pushNotice('warning', 'Thread Goal is disabled in the current Runtime.');
      return;
    }
    const command = parseGoalArgs(args);
    if ('error' in command) {
      session.pushNotice('warning', command.error);
      return;
    }
    switch (command.action) {
      case 'show':
        session.pushNotice(
          'info',
          session.meta.goal
            ? `Goal (${session.meta.goal.status}): ${session.meta.goal.objective}`
            : 'No Goal is set. Use /goal <objective>.',
        );
        break;
      case 'help':
        session.pushNotice(
          'info',
          '/goal <objective> starts a Goal. /goal pause, resume, edit, clear, budget=50K, budget=clear manage it.',
        );
        break;
      case 'pause':
        await session.goalPatch({ status: 'paused' });
        break;
      case 'resume':
        await session.goalPatch({ status: 'active' });
        break;
      case 'clear':
        await session.goalClear();
        break;
      case 'budget':
        await session.goalPatch({ tokenBudget: command.tokenBudget });
        break;
      case 'edit':
        if (command.objective) await session.goalPatch({ objective: command.objective });
        else this.hooks.setDraft(`/goal edit ${session.meta.goal?.objective ?? ''}`);
        break;
      case 'create':
        await session.goalCreate(command.objective, command.tokenBudget);
        break;
    }
  }

  async promptGoal(): Promise<void> {
    const objective = await vscode.window.showInputBox({
      title: 'Alran Goal',
      prompt: 'What should Alran keep working toward?',
    });
    if (objective?.trim()) await this.goal(objective);
  }

  // Prompts -----------------------------------------------------------------

  /** Sends a prompt to the active Session and brings the chat to the front. */
  async sendPrompt(input: PromptInput): Promise<void> {
    const session = await this.runtime.ensureSession();
    await this.hooks.focusChat();
    void session.submit(input);
  }

  async review(): Promise<void> {
    await this.sendPrompt({ text: REVIEW_PROMPT, attachments: [] });
  }

  async init(): Promise<void> {
    await this.sendPrompt({ text: '/init', attachments: [] });
  }

  async agentCommand(name: string): Promise<void> {
    await this.sendPrompt({ text: `/${name}`, attachments: [] });
  }

  // Transcript --------------------------------------------------------------

  private markdown(): string | undefined {
    return this.active ? transcriptToMarkdown(this.active.snapshot) : undefined;
  }

  async exportSession(target: string): Promise<void> {
    const markdown = this.markdown();
    if (!markdown) return;
    const cwd = this.active?.meta.cwd ?? this.runtime.defaultCwd();
    const uri = target
      ? vscode.Uri.file(path.resolve(cwd, target))
      : await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(cwd, 'alran-session.md')),
          filters: { Markdown: ['md'] },
        });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(markdown));
    this.notify(`Exported to ${uri.fsPath}`);
  }

  async showTranscript(): Promise<void> {
    const markdown = this.markdown();
    if (!markdown) return;
    const document = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async copyLastResponse(): Promise<void> {
    const text = this.active?.model.lastAssistantText();
    if (!text) {
      this.notify('There is no response to copy yet.');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage('Alran response copied', 2_000);
  }

  // TUI and account ---------------------------------------------------------

  /** Runs an interactive Alran command in a terminal. */
  async runInTerminal(args: readonly string[], cwd?: string): Promise<vscode.Terminal> {
    const terminal = vscode.window.createTerminal(await this.runtime.terminalOptions(args, cwd));
    terminal.show();
    return terminal;
  }

  /**
   * Opens the current Session in the real TUI for features ACP does not expose.
   * The ACP attachment is released first and restored when the terminal closes.
   */
  async openTui(initialPrompt?: string): Promise<void> {
    const session = this.active;
    const manager = this.runtime.manager;
    if (session?.busy) {
      session.pushNotice('warning', 'Stop the running turn before opening this in the TUI.');
      return;
    }
    const args = [
      ...(session && session.model.items.length > 0 ? ['--session', session.id] : []),
      ...(initialPrompt ? [initialPrompt] : []),
    ];
    const cwd = session?.meta.cwd;
    if (session) await manager.detachForTui(session.id);
    const terminal = await this.runInTerminal(args, cwd);
    if (session) this.terminalReattach.set(terminal, session.id);
  }

  private async reattachAfterTui(sessionId: string): Promise<void> {
    await this.guarded(() => this.runtime.manager.reattachSession(sessionId));
  }

  async login(): Promise<void> {
    await this.account.signIn();
  }

  async logout(): Promise<void> {
    await this.account.signOut();
  }

  /** Restarts the agent so new credentials take effect, and reopens a chat. */
  async afterAccountChange(): Promise<void> {
    const manager = this.runtime.manager;
    if (manager.connection.state === 'disconnected' || manager.connection.state === 'missing-binary') return;
    await this.guarded(async () => {
      await manager.restart();
      if (!manager.active) await this.runtime.ensureSession();
    });
  }

  async update(): Promise<void> {
    const busy = [...this.runtime.manager.sessions.values()].some((session) => session.busy);
    if (busy) {
      const proceed = 'Update Anyway';
      const choice = await vscode.window.showWarningMessage(
        'A task is running. Updating restarts the agent and stops it.',
        { modal: true },
        proceed,
      );
      if (choice !== proceed) return;
    }
    const terminal = await this.runInTerminal(['update']);
    const listener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      listener.dispose();
      void this.guarded(async () => {
        await this.restartAgent();
        await this.account.refresh();
      });
    });
  }

  async mascot(): Promise<void> {
    await this.runInTerminal(['mascot']);
  }

  async restartAgent(): Promise<void> {
    await this.runtime.manager.restart();
    if (!this.runtime.manager.active) await this.runtime.ensureSession();
    this.notify('Agent restarted. New chats load Plugins and Skills you installed.');
  }

  private dataDir(): string {
    return this.runtime.dataDir();
  }

  async openConfigFile(): Promise<void> {
    const uri = vscode.Uri.file(path.join(this.dataDir(), 'config.yaml'));
    try {
      await vscode.window.showTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${uri.fsPath}. Start Alran once to create it.`);
    }
  }

  async openSettings(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Extension Settings', id: 'extension' },
        { label: 'Alran config.yaml', description: this.dataDir(), id: 'config' },
        { label: 'TUI /settings', description: 'Opens in the integrated terminal', id: 'tui' },
      ],
      { placeHolder: 'Alran preferences' },
    );
    if (picked?.id === 'extension') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ottili.alran-vscode');
    } else if (picked?.id === 'config') await this.openConfigFile();
    else if (picked?.id === 'tui') await this.openTui('/settings');
  }

  async showChangelog(): Promise<void> {
    const cli = await this.runtime.resolveCli();
    const entry = await realpath(cli.prefixArgs[0] ?? cli.displayPath).catch(() => cli.prefixArgs[0] ?? cli.displayPath);
    const directory = path.dirname(entry);
    for (const candidate of [
      path.join(directory, 'chunks', 'CHANGELOG.md'),
      path.join(directory, 'CHANGELOG.md'),
      path.join(directory, '..', 'CHANGELOG.md'),
      path.join(directory, '..', 'packages', 'tui', 'CHANGELOG.md'),
      path.join(directory, '..', 'lib', 'node_modules', 'alran', 'dist', 'chunks', 'CHANGELOG.md'),
      path.join(directory, '..', 'lib', 'node_modules', 'alran', 'CHANGELOG.md'),
    ]) {
      const content = await readFile(candidate, 'utf8').catch(() => undefined);
      if (content !== undefined) {
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument({ content, language: 'markdown' }),
          { preview: true },
        );
        return;
      }
    }
    await this.openTui('/changelog');
  }
}
