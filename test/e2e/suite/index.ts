import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as vscode from 'vscode';

import { modelKeyFromConfigValue } from '../../../src/core/account';
import type { SessionController } from '../../../src/core/session';
import type { AlranExtensionApi } from '../../../src/extension';

async function chooseModel(session: SessionController, key: string, variant = ''): Promise<void> {
  const option = session.meta.config.find((entry) => entry.id === 'model');
  const choice = option?.options.find(
    (entry) => modelKeyFromConfigValue(entry.value) === key && entry.value.endsWith(`:v:${variant}`),
  );
  assert.ok(choice, `model ${key} is offered`);
  await session.setConfigOption('model', choice.value);
}

const workspace = process.env.ALRAN_E2E_WORKSPACE ?? '';
const screenshotDir = process.env.ALRAN_E2E_SCREENSHOT_DIR ?? '';

async function waitFor(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function screenshot(name: string): void {
  if (!screenshotDir) return;
  try {
    execFileSync('python3', [
      '-c',
      `from PIL import ImageGrab; ImageGrab.grab(xdisplay=${JSON.stringify(process.env.DISPLAY)}).save(${JSON.stringify(path.join(screenshotDir, `${name}.png`))})`,
    ]);
  } catch (error) {
    console.warn(`screenshot failed: ${String(error)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const marketingDir = process.env.ALRAN_E2E_MARKETING_DIR ?? '';

/** A clean shot for the README: no notifications, no secondary side bar. */
async function marketingShot(name: string): Promise<void> {
  if (!marketingDir) return;
  await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
  await sleep(500);
  try {
    execFileSync('python3', [
      '-c',
      `from PIL import ImageGrab; ImageGrab.grab(xdisplay=${JSON.stringify(process.env.DISPLAY)}).save(${JSON.stringify(path.join(marketingDir, `${name}.png`))})`,
    ]);
  } catch (error) {
    console.warn(`marketing screenshot failed: ${String(error)}`);
  }
}

const steps: Array<[string, (api: AlranExtensionApi) => Promise<void>]> = [
  [
    'registers every contributed command',
    async () => {
      const manifest = vscode.extensions.getExtension('ottili.alran-vscode')?.packageJSON as {
        contributes: { commands: Array<{ command: string }> };
      };
      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = manifest.contributes.commands.filter((entry) => !registered.has(entry.command));
      assert.deepEqual(missing, []);
    },
  ],
  [
    'boots the webview under its CSP and connects to the real agent',
    async (api) => {
      await vscode.commands.executeCommand('alran.chat.focus');
      await waitFor('webview ready', () => api.hub.readySurfaceCount > 0, 60_000);
      await waitFor('session', () => api.runtime.manager.active?.meta.status === 'idle', 60_000);
      assert.equal(api.runtime.manager.connection.state, 'connected');
      await waitFor('skills', () => api.runtime.manager.active!.meta.commands.some((c) => c.source === 'skill'));
      await sleep(800);
      screenshot('01-welcome');
    },
  ],
  [
    'runs a prompt end to end',
    async (api) => {
      const session = api.runtime.manager.active!;
      await api.actions.sendPrompt({ text: 'hello from vscode', attachments: [] });
      await waitFor('reply', () => session.model.lastAssistantText()?.includes('Echo') === true);
      await waitFor('idle', () => session.meta.status === 'idle');
    },
  ],
  [
    'shows edits in the diff editor and reverts them',
    async (api) => {
      const session = api.runtime.manager.active!;
      const target = path.join(workspace, 'a.txt');
      await vscode.window.showTextDocument(vscode.Uri.file(target));
      await api.actions.sendPrompt({ text: 'DO_EDIT now', attachments: [] });
      await waitFor('edit', () => readFileSync(target, 'utf8').includes('line TWO'));
      await waitFor('change tracked', () => session.changes.get(target)?.before?.includes('line two') === true);
      await waitFor('idle', () => session.meta.status === 'idle');
      await sleep(400);
      screenshot('02-edit');
      await vscode.commands.executeCommand('alran.openChange', {
        kind: 'change',
        change: session.changes.get(target),
      });
      await waitFor('diff tab', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
      await sleep(600);
      screenshot('03-diff');
      await session.changes.revert(target);
      assert.equal(readFileSync(target, 'utf8'), 'line one\nline two\nline three\n');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'answers a permission card',
    async (api) => {
      const session = api.runtime.manager.active!;
      await session.setConfigOption('permissionMode', 'default');
      void api.actions.sendPrompt({ text: 'DO_OUTSIDE please', attachments: [] });
      await waitFor('permission', () => session.meta.status === 'awaiting-input');
      await sleep(400);
      screenshot('04-permission');
      const request = session.model.items.find((item) => item.kind === 'permission');
      assert.ok(request);
      session.answerPermission(request.id, 'allow-once');
      await waitFor('idle', () => session.meta.status === 'idle');
    },
  ],
  [
    'asks a question and shows the follow-up',
    async (api) => {
      const session = api.runtime.manager.active!;
      void api.actions.sendPrompt({ text: 'DO_ASK please', attachments: [] });
      await waitFor('question', () => session.model.items.some((item) => item.kind === 'question' && !item.resolution));
      await sleep(1_500);
      screenshot('05-question');
      const question = session.model.items.find((item) => item.kind === 'question' && !item.resolution);
      assert.equal(question?.kind, 'question');
      if (question?.kind !== 'question') return;
      session.answerQuestion(question.id, 'accept', { [question.fields[0]!.id]: question.fields[0]!.options[1]!.value });
      await waitFor('continuation', () => session.model.lastAssistantText()?.includes('Thanks for answering') === true);
      await waitFor('idle', () => session.meta.status === 'idle');
    },
  ],
  [
    'routes slash commands typed in the chat',
    async (api) => {
      const hub = api.hub as unknown as { dispatch(surface: unknown, message: unknown): Promise<void> };
      const before = api.runtime.manager.sessions.size;
      await hub.dispatch({}, { type: 'send', text: '/fork', attachments: [], includeActiveFile: false });
      await waitFor('fork tab', () => api.runtime.manager.sessions.size === before + 1);
      const fork = api.runtime.manager.active!;
      await waitFor('fork ready', () => fork.meta.status === 'idle');
      assert.ok(fork.model.items.length > 0, 'fork shows history');
      await hub.dispatch({}, { type: 'send', text: '/quit', attachments: [], includeActiveFile: false });
      await waitFor('fork closed', () => api.runtime.manager.sessions.size === before);

      await hub.dispatch({}, { type: 'send', text: '/usage', attachments: [], includeActiveFile: false });
      const session = api.runtime.manager.active!;
      await waitFor('usage', () => session.model.lastAssistantText()?.includes('Session usage') === true);
      await waitFor('idle', () => session.meta.status === 'idle');
    },
  ],
  [
    'shows a Goal, the queue and a running turn',
    async (api) => {
      const session = api.runtime.manager.active!;
      await session.goalCreate('Ship the VS Code extension', 50_000);
      await session.goalPatch({ status: 'paused' });
      await waitFor('background settled', () => session.meta.status === 'idle', 20_000);
      void api.actions.sendPrompt({ text: 'DO_SLOW now', attachments: [] });
      await waitFor('streaming', () => session.model.items.at(-1)?.kind === 'assistant');
      session.enqueue({ text: 'A queued follow-up', attachments: [] });
      await sleep(300);
      screenshot('06-running');
      await waitFor('queue drained', () => session.meta.queue.length === 0 && session.meta.status === 'idle', 30_000);
      await session.goalClear();
    },
  ],
  [
    'fills the Sessions, Changes and Capabilities views',
    async (api) => {
      const session = api.runtime.manager.active!;
      const { sessions, changes, capabilities } = api.trees;
      const listed = await sessions.getChildren();
      assert.ok(listed.some((node) => node.session.sessionId === session.id));
      assert.equal(sessions.getTreeItem(listed[0]!).contextValue?.startsWith('session'), true);

      const target = path.join(workspace, 'a.txt');
      await api.actions.sendPrompt({ text: 'DO_EDIT again', attachments: [] });
      await waitFor('edit', () => readFileSync(target, 'utf8').includes('line TWO'));
      await waitFor('idle', () => session.meta.status === 'idle');
      await waitFor('listed', () => changes.getChildren().some((node) => node.change.path === target));
      await session.changes.revert(target);

      const groups = await capabilities.getChildren();
      assert.deepEqual(groups.map((node) => node.kind === 'group' && node.group), ['skills', 'mcp', 'plugins', 'providers']);
      const skills = await capabilities.getChildren(groups[0]!);
      assert.ok(skills.some((node) => node.kind === 'skill'));
      const mcp = await capabilities.getChildren(groups[1]!);
      assert.ok(mcp.length > 0);
      const providers = await capabilities.getChildren(groups[3]!);
      assert.ok(providers.some((node) => node.kind === 'provider' && node.provider.providerId === 'custom_provider:fixture'));
    },
  ],
  [
    'runs the client-side slash commands',
    async (api) => {
      const session = api.runtime.manager.active!;
      const hub = api.hub as unknown as { dispatch(surface: unknown, message: unknown): Promise<void> };
      const run = (text: string) => hub.dispatch({}, { type: 'send', text, attachments: [], includeActiveFile: false });
      const notices = () => session.model.items.filter((item) => item.kind === 'notice').map((item) => item.kind === 'notice' && item.text);

      await run('/plan status');
      assert.ok(notices().some((text) => text && text.startsWith('Mode:')));
      await run('/permission status');
      assert.ok(notices().some((text) => text && text.startsWith('Permission mode:')));
      await run('/goal Finish the docs');
      assert.equal(session.meta.goal?.objective, 'Finish the docs');
      await run('/goal budget=2K');
      assert.equal(session.meta.goal?.tokenBudget, 2000);
      await run('/goal pause');
      assert.equal(session.meta.goal?.status, 'paused');
      await run('/goal clear');
      assert.equal(session.meta.goal, null);
      await waitFor('settled', () => session.meta.status === 'idle', 20_000);
      await run('/copy');
      assert.ok((await vscode.env.clipboard.readText()).length > 0);
    },
  ],
  [
    'hands a Session to the real TUI and takes it back',
    async (api) => {
      const session = api.runtime.manager.active!;
      await api.actions.openTui();
      await waitFor('detached', () => session.meta.status === 'detached');
      await waitFor('terminal', () => vscode.window.terminals.some((terminal) => terminal.name === 'Alran Code'));
      await sleep(7_000);
      screenshot('07-tui');
      for (const terminal of vscode.window.terminals) terminal.dispose();
      await waitFor('reattached', () => session.meta.status === 'idle', 30_000);
      assert.ok(session.model.items.some((item) => item.kind === 'user'));
    },
  ],
  [
    'exports a transcript and lists sessions',
    async (api) => {
      await api.actions.showTranscript();
      await waitFor('transcript', () => vscode.window.activeTextEditor?.document.languageId === 'markdown');
      assert.match(vscode.window.activeTextEditor!.document.getText(), /hello from vscode/u);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const listed = await api.runtime.manager.listSessions(workspace);
      assert.ok(listed.some((entry) => entry.sessionId === api.runtime.manager.activeId));
    },
  ],
  [
    'shows the account view and detects the own provider',
    async (api) => {
      await waitFor('account', () => api.account.snapshot.status !== undefined && !api.account.snapshot.loading, 30_000);
      assert.equal(api.account.snapshot.status?.signedIn, false);
      assert.deepEqual(api.account.snapshot.credential, { kind: 'provider', name: 'fixture' });
      const rows = api.trees.account.getChildren();
      assert.ok(rows.some((row) => row.id === 'account.provider'));
      await vscode.commands.executeCommand('alran.account.focus');
      await sleep(600);
      screenshot('08-account-signed-out');
    },
  ],
  [
    'signs in with a device code from the editor',
    async (api) => {
      const ottili = process.env.ALRAN_E2E_OTTILI ?? '';
      const signedIn = api.account.signIn({ flow: 'device' });
      await waitFor('device code shown', async () => {
        const state = (await (await fetch(`${ottili}/__test/state`)).json()) as { calls: string[] };
        return state.calls.includes('POST /v1/auth/device');
      });
      await sleep(1_200);
      screenshot('09-device-code');
      const opened = readFileSync(process.env.ALRAN_TEST_OPEN_EXTERNAL_LOG ?? '', 'utf8');
      assert.match(opened, /\/device\?user_code=BCDF-GHJK/u, 'the confirmation page opens with the code filled in');
      await fetch(`${ottili}/__test/approve`, { method: 'POST' });
      const result = await signedIn;
      const state = (await (await fetch(`${ottili}/__test/state`)).json()) as unknown;
      const diagnostics = JSON.stringify({ result, snapshot: api.account.snapshot, state }).slice(0, 3000);
      assert.equal(result, true, diagnostics);
      assert.equal(api.account.snapshot.status?.name, 'Test Person', diagnostics);
      await waitFor('credits', () => api.account.snapshot.credits?.available_microcents === 4_800_000);
      await waitFor('agent back', () => api.runtime.manager.connection.state === 'connected' && api.runtime.manager.active?.meta.status === 'idle', 60_000);
      const rows = api.trees.account.getChildren();
      assert.deepEqual(
        rows.map((row) => row.id),
        ['account.user', 'account.company', 'account.project', 'account.model', 'account.credits', 'account.month', 'account.billing', 'account.cli'],
      );
      await vscode.commands.executeCommand('alran.account.focus');
      await vscode.commands.executeCommand('list.expandAll').then(undefined, () => undefined);
      await sleep(800);
      screenshot('10-account-signed-in');
      const [accountSession] = await api.authProvider.getSessions();
      assert.equal(accountSession?.account.label, 'Test Person');
      assert.equal(accountSession?.accessToken, '', 'the Platform session never leaves the CLI');
    },
  ],
  [
    'shows prices and availability in the model picker',
    async (api) => {
      await api.account.refresh({ usage: true });
      const picking = vscode.commands.executeCommand('alran.pickModel');
      await sleep(1_200);
      screenshot('11-model-picker');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await picking;
      assert.ok(api.account.snapshot.models?.some((model) => model.status === 'requires purchased credit'));
    },
  ],
  [
    'turns a failed turn into a card with actions',
    async (api) => {
      const session = api.runtime.manager.active!;
      await api.actions.sendPrompt({ text: 'DO_FAIL_402 please', attachments: [] });
      await waitFor('failure', () => session.model.items.some((item) => item.kind === 'notice' && item.failure !== undefined), 90_000);
      await waitFor('idle', () => session.meta.status === 'idle');
      const notice = session.model.items.findLast((item) => item.kind === 'notice');
      assert.equal(notice?.kind === 'notice' && notice.failure?.kind, 'model-restricted');
      await vscode.commands.executeCommand('alran.chat.focus');
      await sleep(600);
      screenshot('12-failure-card');
    },
  ],
  [
    'answers @alran in the editor chat without taking over the sidebar',
    async (api) => {
      const participant = api.chatParticipant;
      if (!participant) {
        console.log('      (no Chat view in this editor; skipped)');
        return;
      }
      const activeBefore = api.runtime.manager.activeId;
      const markdown: string[] = [];
      const progress: string[] = [];
      const buttons: string[] = [];
      const stream = {
        markdown: (value: string | vscode.MarkdownString) => markdown.push(typeof value === 'string' ? value : value.value),
        progress: (value: string) => progress.push(value),
        button: (command: vscode.Command) => buttons.push(command.command),
        reference: () => undefined,
        anchor: () => undefined,
        filetree: () => undefined,
        push: () => undefined,
      } as unknown as vscode.ChatResponseStream;
      const request = { prompt: 'hello from the editor chat', command: undefined, references: [] } as unknown as vscode.ChatRequest;
      const token = new vscode.CancellationTokenSource().token;
      const result = (await participant.handler(request, { history: [] } as unknown as vscode.ChatContext, stream, token)) as vscode.ChatResult;
      assert.match(markdown.join(''), /Echo/u);
      const sessionId = (result.metadata as { alranSessionId?: string }).alranSessionId;
      assert.ok(sessionId && api.runtime.manager.sessions.has(sessionId));
      assert.equal(api.runtime.manager.activeId, activeBefore, 'the sidebar chat keeps its tab');
      assert.ok(buttons.includes('alran.showSession'));
      await api.runtime.manager.closeSession(sessionId);
    },
  ],
  [
    'captures the README screenshots',
    async (api) => {
      if (!marketingDir) return;
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.closePanel').then(undefined, () => undefined);
      await api.actions.newSession();
      const session = api.runtime.manager.active!;
      await waitFor('idle', () => session.meta.status === 'idle');
      const source = path.join(workspace, 'src', 'date.ts');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.window.showTextDocument(vscode.Uri.file(source), { preview: false, viewColumn: vscode.ViewColumn.One });
      api.hub.openInEditor();
      await waitFor('panel ready', () => api.hub.readySurfaceCount > 1, 30_000);
      await session.setConfigOption('permissionMode', 'auto');
      await chooseModel(session, 'alran/Alran-Werk');
      await api.actions.sendPrompt({ text: 'Make parseDate reject invalid dates', attachments: [] });
      await waitFor('demo reply', () => session.model.lastAssistantText()?.includes('Changes') === true, 60_000);
      await waitFor('idle', () => session.meta.status === 'idle');
      await sleep(1_000);
      await marketingShot('chat');

      await session.setConfigOption('permissionMode', 'default');
      void api.actions.sendPrompt({ text: 'Also copy the result to the shared folder', attachments: [] });
      await waitFor('permission', () => session.meta.status === 'awaiting-input', 30_000);
      await sleep(600);
      await marketingShot('permission');
      const request = session.model.items.findLast((item) => item.kind === 'permission' && !item.resolution);
      if (request) session.answerPermission(request.id, 'deny');
      await waitFor('idle', () => session.meta.status === 'idle', 30_000);

      await vscode.commands.executeCommand('alran.account.focus');
      await sleep(600);
      const picking = vscode.commands.executeCommand('alran.pickModel');
      await sleep(1_200);
      await marketingShot('account');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await picking;

      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await chooseModel(session, 'alran/anthropic/claude-opus-5.5', 'thinking');
      await api.actions.sendPrompt({ text: 'Now review the whole module with Claude Opus', attachments: [] });
      await waitFor('failure', () => session.model.items.some((item) => item.kind === 'notice' && item.failure !== undefined), 90_000);
      await waitFor('idle', () => session.meta.status === 'idle');
      await sleep(600);
      await marketingShot('failure');
      await session.changes.revert(source).catch(() => undefined);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'signs out and revokes the session',
    async (api) => {
      const ottili = process.env.ALRAN_E2E_OTTILI ?? '';
      assert.equal(await api.account.signOut({ confirm: false }), true);
      assert.equal(api.account.snapshot.status?.signedIn, false);
      const state = (await (await fetch(`${ottili}/__test/state`)).json()) as { revoked: string[] };
      assert.equal(state.revoked.length, 1);
      await waitFor('agent back', () => api.runtime.manager.connection.state === 'connected' && api.runtime.manager.active?.meta.status === 'idle', 60_000);
    },
  ],
  [
    'restarts the agent and reattaches',
    async (api) => {
      const session = api.runtime.manager.active!;
      await api.actions.restartAgent();
      await waitFor('reattached', () => session.meta.status === 'idle' && api.runtime.manager.connection.state === 'connected', 60_000);
      await api.actions.sendPrompt({ text: 'after restart', attachments: [] });
      await waitFor('reply', () => session.model.lastAssistantText()?.includes('after restart') === true);
      await waitFor('idle', () => session.meta.status === 'idle');
    },
  ],
];

/** Without the CLI, the extension must say so and offer the installation. */
async function runWithoutCli(api: AlranExtensionApi): Promise<void> {
  await sleep(2_500);
  screenshot('00-no-cli-notice');
  await vscode.commands.executeCommand('alran.chat.focus');
  await waitFor('webview ready', () => api.hub.readySurfaceCount > 0, 60_000);
  await waitFor('missing binary', () => api.runtime.manager.connection.state === 'missing-binary', 30_000);
  await waitFor('account row', () => api.trees.account.getChildren().some((row) => row.id === 'account.nocli'), 30_000);
  await vscode.commands.executeCommand('alran.account.focus');
  await sleep(800);
  screenshot('00-no-cli-card');
  await sleep(3_000);
  screenshot('00-no-cli-card-later');
  console.log('  ok  explains that the Alran CLI is required');
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AlranExtensionApi>('ottili.alran-vscode');
  assert.ok(extension, 'extension is installed');
  const api = await extension.activate();
  if (process.env.ALRAN_E2E_NO_CLI) {
    await runWithoutCli(api);
    return;
  }
  const failures: string[] = [];
  const only = process.env.ALRAN_E2E_ONLY ? new RegExp(process.env.ALRAN_E2E_ONLY, 'u') : undefined;
  for (const [name, step] of steps) {
    if (only && !only.test(name) && !/boots the webview/u.test(name)) continue;
    try {
      await step(api);
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`FAIL  ${name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      const log = api.runtime.manager.active?.model.items.slice(-4);
      console.error(JSON.stringify(log)?.slice(0, 1500));
    }
  }
  await api.runtime.manager.dispose();
  if (failures.length > 0) throw new Error(`${String(failures.length)} step(s) failed: ${failures.join('; ')}`);
}
