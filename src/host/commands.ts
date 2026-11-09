import * as vscode from 'vscode';

import * as cli from '../core/cli';
import type { ComposerAttachment } from '../shared/types';
import type { AlranActions } from './actions';
import type { ChatHub } from './chatHub';
import {
  attachmentsFromUris,
  fileAttachment,
  formatDiagnostics,
  selectionAttachment,
  textAttachment,
} from './context';
import { openChangeDiff } from './diff';
import type { AlranRuntime } from './runtime';
import type { AgentsTree, CapabilitiesTree, CapabilityNode, ChangeNode, ChangesTree, SessionNode, SessionsTree } from './trees';

export interface CommandDependencies {
  readonly runtime: AlranRuntime;
  readonly actions: AlranActions;
  readonly hub: ChatHub;
  readonly sessions: SessionsTree;
  readonly changes: ChangesTree;
  readonly agents: AgentsTree;
  readonly capabilities: CapabilitiesTree;
}

const API_FORMATS = ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'];

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { runtime, actions, hub, sessions, changes, agents, capabilities } = deps;

  const addToChat = async (attachments: readonly ComposerAttachment[]) => {
    await hub.focus();
    hub.addAttachments(attachments);
  };

  const withEditor = (run: (editor: vscode.TextEditor) => Promise<void>) => async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await run(editor);
    else void vscode.window.showInformationMessage('Open a file first.');
  };

  const askAboutSelection = (instruction: string) =>
    withEditor(async (editor) => {
      const selection = selectionAttachment(editor);
      const attachments = selection ? [selection] : [fileAttachment(editor.document.uri)];
      await actions.sendPrompt({ text: instruction, attachments });
    });

  const refreshCapabilities = () => capabilities.refresh();

  const withProgress = (title: string, run: () => Promise<void>) =>
    vscode.window.withProgress({ location: { viewId: 'alran.capabilities' }, title }, run);

  const pluginAction = (action: cli.PluginAction, verb: string) => async (node: CapabilityNode) => {
    if (node.kind !== 'plugin') return;
    await withProgress(`${verb} ${node.plugin.name}…`, async () => {
      await cli.plugins.action(await runtime.cliContext(), action, cli.pluginSelector(node.plugin));
    });
    refreshCapabilities();
    const reload = 'Reload Agent';
    const choice = await vscode.window.showInformationMessage(
      `${node.plugin.name}: ${verb.toLowerCase()} done. Reload the agent to apply it.`,
      reload,
    );
    if (choice === reload) await actions.restartAgent();
  };

  const handlers: Record<string, (...args: never[]) => unknown> = {
    // Chat and sessions
    'alran.openChat': () => hub.focus(),
    'alran.openInEditor': () => hub.openInEditor(),
    'alran.newSession': () => actions.newSession(),
    'alran.resumeSession': () => actions.pickSession(),
    'alran.openSession': (node: SessionNode) =>
      actions.openSession(node.session.sessionId, node.session.cwd, node.session.title),
    'alran.forkSession': (node?: SessionNode) => actions.fork(node?.session.sessionId),
    'alran.closeSession': (node?: SessionNode) => actions.closeTab(node?.session.sessionId),
    'alran.refreshSessions': () => sessions.refresh(),
    'alran.sideQuestion': async () => {
      const question = await vscode.window.showInputBox({
        title: 'Side question',
        prompt: 'Ask without interrupting the running task',
      });
      if (question !== undefined) await actions.sideQuestion(question);
    },
    'alran.cancel': () => actions.cancel(),
    'alran.retry': () => actions.retry(),
    'alran.compact': () => actions.agentCommand('compact'),
    'alran.exportSession': () => actions.exportSession(''),
    'alran.showTranscript': () => actions.showTranscript(),
    'alran.copyLastResponse': () => actions.copyLastResponse(),

    // Controls
    'alran.pickModel': () => actions.pickConfig('model'),
    'alran.pickEffort': () => actions.pickConfig('thinkingEffort'),
    'alran.pickPermissionMode': () => actions.pickConfig('permissionMode'),
    'alran.togglePlanMode': () => actions.cycleMode(),
    'alran.viewPlan': () => actions.viewLatestPlan(),

    // Goal and agents
    'alran.goalStart': () => actions.promptGoal(),
    'alran.goalPause': () => actions.goal('pause'),
    'alran.goalResume': () => actions.goal('resume'),
    'alran.goalClear': () => actions.goal('clear'),
    'alran.agentsStop': async () => {
      await runtime.manager.active?.stopDelegation();
      agents.refresh();
    },

    // Editor context
    'alran.addSelection': withEditor(async (editor) => {
      const selection = selectionAttachment(editor);
      await addToChat([selection ?? fileAttachment(editor.document.uri)]);
    }),
    'alran.addFile': async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected?.length ? selected : uri ? [uri] : [];
      if (targets.length > 0) {
        await addToChat(await attachmentsFromUris(targets));
      } else if (vscode.window.activeTextEditor) {
        await addToChat([fileAttachment(vscode.window.activeTextEditor.document.uri)]);
      }
    },
    'alran.addTerminalSelection': async () => {
      // No stable API exposes the terminal selection, so it travels via the clipboard.
      const previous = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      const text = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText(previous);
      if (text && text !== previous) await addToChat([textAttachment('Terminal selection', text)]);
      else void vscode.window.showInformationMessage('Select some text in the terminal first.');
    },
    'alran.explainSelection': askAboutSelection('Explain this code.'),
    'alran.fixSelection': askAboutSelection('Find and fix the problems in this code.'),
    'alran.fixDiagnostics': async (uri?: vscode.Uri, diagnostics?: readonly vscode.Diagnostic[]) => {
      const document = uri
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor?.document;
      if (!document) return;
      const problems = diagnostics ?? vscode.languages.getDiagnostics(document.uri);
      if (problems.length === 0) {
        void vscode.window.showInformationMessage('No problems were reported in this file.');
        return;
      }
      await actions.sendPrompt({
        text: 'Fix these problems.',
        attachments: [
          fileAttachment(document.uri),
          textAttachment('Problems', formatDiagnostics(document, problems)),
        ],
      });
    },

    // Slash-command equivalents
    'alran.reviewChanges': () => actions.review(),
    'alran.initProject': () => actions.init(),
    'alran.status': () => actions.agentCommand('status'),
    'alran.doctor': () => actions.agentCommand('doctor'),
    'alran.usage': () => actions.agentCommand('usage'),
    'alran.context': () => actions.agentCommand('context'),
    'alran.skills': () => actions.agentCommand('skills'),
    'alran.mcp': () => actions.agentCommand('mcp'),
    'alran.help': () => actions.agentCommand('help'),
    'alran.changelog': () => actions.showChangelog(),

    // Changes
    'alran.openChange': (node: ChangeNode) => {
      const session = runtime.manager.active;
      return session ? openChangeDiff(actions.documents, session, node.change.path) : undefined;
    },
    'alran.revertChange': async (node: ChangeNode) => {
      const session = runtime.manager.active;
      if (!session) return;
      const name = vscode.workspace.asRelativePath(node.change.path);
      const message =
        node.change.before === null
          ? `Delete ${name}? Alran created this file.`
          : `Restore ${name} to its content before this session changed it?`;
      const confirm = 'Revert';
      if ((await vscode.window.showWarningMessage(message, { modal: true }, confirm)) !== confirm) return;
      await session.changes.revert(node.change.path);
      changes.refresh();
    },
    'alran.revertAllChanges': async () => {
      const session = runtime.manager.active;
      if (!session) return;
      const revertible = session.changes.list().filter((change) => change.before !== undefined);
      if (revertible.length === 0) return;
      const confirm = 'Revert All';
      const choice = await vscode.window.showWarningMessage(
        `Revert ${String(revertible.length)} file(s) to their content before this session changed them?`,
        { modal: true },
        confirm,
      );
      if (choice !== confirm) return;
      for (const change of revertible) await session.changes.revert(change.path);
      changes.refresh();
    },
    'alran.clearChanges': () => {
      runtime.manager.active?.changes.clear();
      changes.refresh();
    },
    'alran.refreshChanges': () => changes.refresh(),

    // Capabilities
    'alran.refreshCapabilities': refreshCapabilities,
    'alran.insertSkill': async (name: string) => {
      await hub.focus();
      hub.setDraft(`/${name} `);
    },
    'alran.pluginInstall': pluginAction('add', 'Installing'),
    'alran.pluginUninstall': pluginAction('remove', 'Removing'),
    'alran.pluginEnable': pluginAction('enable', 'Enabling'),
    'alran.pluginDisable': pluginAction('disable', 'Disabling'),
    'alran.pluginInstallBySelector': async () => {
      const selector = await vscode.window.showInputBox({
        title: 'Install Plugin',
        prompt: 'Plugin selector, for example name@official',
      });
      if (!selector?.trim()) return;
      await withProgress(`Installing ${selector}…`, async () => {
        await cli.plugins.action(await runtime.cliContext(), 'add', selector.trim());
      });
      refreshCapabilities();
    },
    'alran.pluginMarketplaceUpgrade': async () => {
      await withProgress('Refreshing Plugin sources…', async () => {
        await cli.plugins.upgradeMarketplaces(await runtime.cliContext());
      });
      refreshCapabilities();
    },
    'alran.providerAdd': async () => {
      const name = await vscode.window.showInputBox({ title: 'Add provider (1/4)', prompt: 'Display name' });
      if (!name?.trim()) return;
      const baseUrl = await vscode.window.showInputBox({
        title: 'Add provider (2/4)',
        prompt: 'API base URL',
        placeHolder: 'https://api.example.com/v1',
      });
      if (!baseUrl?.trim()) return;
      const apiFormat = await vscode.window.showQuickPick(API_FORMATS, {
        title: 'Add provider (3/4)',
        placeHolder: 'API format',
      });
      if (!apiFormat) return;
      const models = await vscode.window.showInputBox({
        title: 'Add provider (4/4)',
        prompt: 'Model IDs, separated by commas',
      });
      if (!models?.trim()) return;
      const apiKey = await vscode.window.showInputBox({
        title: 'API key',
        prompt: 'Leave empty for providers that need no key',
        password: true,
      });
      if (apiKey === undefined) return;
      await withProgress(`Adding ${name}…`, async () => {
        await cli.providers.add(await runtime.cliContext(), {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiFormat,
          models: models.split(',').map((model) => model.trim()).filter(Boolean),
          ...(apiKey ? { apiKey } : {}),
        });
      });
      refreshCapabilities();
      await actions.restartAgent();
    },
    'alran.providerRemove': async (node: CapabilityNode) => {
      if (node.kind !== 'provider') return;
      const confirm = 'Remove';
      const choice = await vscode.window.showWarningMessage(
        `Remove provider ${node.provider.name}?`,
        { modal: true },
        confirm,
      );
      if (choice !== confirm) return;
      await cli.providers.remove(await runtime.cliContext(), node.provider.providerId);
      refreshCapabilities();
      await actions.restartAgent();
    },
    'alran.providerTest': async (node: CapabilityNode) => {
      if (node.kind !== 'provider') return;
      const result = await cli.providers.test(await runtime.cliContext(), node.provider.providerId);
      runtime.output.info(result.stdout);
      if (result.code === 0) void vscode.window.showInformationMessage(`${node.provider.name} responded.`);
      else void vscode.window.showErrorMessage(`${node.provider.name}: ${(result.stderr || result.stdout).trim()}`);
    },
    'alran.providerUseSource': async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Token Plan', value: 'token-plan' as const },
          { label: 'Alran API key', value: 'api-key' as const },
        ],
        { placeHolder: 'Alran credential source' },
      );
      if (!picked) return;
      await cli.providers.use(await runtime.cliContext(), picked.value);
      refreshCapabilities();
      await actions.restartAgent();
    },
    'alran.providerSetKey': async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'Alran API key',
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey) return;
      await cli.providers.setAlranKey(await runtime.cliContext(), apiKey);
      refreshCapabilities();
      await actions.restartAgent();
    },

    // Account and maintenance
    'alran.login': () => actions.login(),
    'alran.logout': () => actions.logout(),
    'alran.update': () => actions.update(),
    'alran.installCli': () => actions.offerInstall(),
    'alran.restartAgent': () => actions.restartAgent(),
    'alran.openConfig': () => actions.openConfigFile(),
    'alran.openSettings': () => actions.openSettings(),
    'alran.openTui': () => actions.openTui(),
    'alran.tuiCommand': async () => {
      const picked = await vscode.window.showQuickPick(
        ['/rewind', '/edit', '/rename', '/history', '/tasks', '/add-dir', '/feedback', '/settings', '/statusline', '/theme', '/hotkeys'].map(
          (label) => ({ label }),
        ),
        { placeHolder: 'Open this Session in the TUI with…' },
      );
      if (picked) await actions.openTui(picked.label);
    },
    'alran.telemetryStatus': async () => {
      runtime.output.info(await cli.telemetry.status(await runtime.cliContext()));
      runtime.output.show();
    },
    'alran.telemetryPreview': async () => {
      runtime.output.info(await cli.telemetry.preview(await runtime.cliContext()));
      runtime.output.show();
    },
    'alran.showLogs': () => runtime.output.show(),
    'alran.mascot': () => actions.mascot(),
  };

  return Object.entries(handlers).map(([id, handler]) =>
    vscode.commands.registerCommand(id, (...args: never[]) => {
      return actions.guarded(async () => {
        await handler(...args);
      });
    }),
  );
}
