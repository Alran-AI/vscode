import * as vscode from 'vscode';

import * as cli from '../core/cli';
import { describeFailure } from '../shared/errors';
import type { ComposerAttachment } from '../shared/types';
import type { AccountService } from './account';
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
  readonly account: AccountService;
  readonly sessions: SessionsTree;
  readonly changes: ChangesTree;
  readonly agents: AgentsTree;
  readonly capabilities: CapabilitiesTree;
}

const API_FORMATS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const API_FORMAT_HINTS: Readonly<Record<string, string>> = {
  'openai-completions': 'OpenAI-compatible /chat/completions (most providers, vLLM, Ollama)',
  'openai-responses': 'OpenAI Responses API',
  'anthropic-messages': 'Anthropic Messages API',
  'google-generative-ai': 'Google Gemini API',
};

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { runtime, actions, hub, account, sessions, changes, agents, capabilities } = deps;

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
    'alran.pickModel': (sessionId?: string) => {
      if (typeof sessionId === 'string' && runtime.manager.sessions.has(sessionId)) runtime.manager.setActive(sessionId);
      return actions.pickModel();
    },
    'alran.useWerk': (sessionId?: string) => actions.useWerk(typeof sessionId === 'string' ? sessionId : undefined),
    'alran.answerPermission': (sessionId: string, itemId: string, optionId: string) => {
      runtime.manager.sessions.get(sessionId)?.answerPermission(itemId, optionId);
    },
    'alran.showSession': async (sessionId: string) => {
      if (runtime.manager.sessions.has(sessionId)) runtime.manager.setActive(sessionId);
      await hub.focus();
    },
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
      const title = 'Add a model provider';
      const name = await vscode.window.showInputBox({
        title: `${title} (1/5)`,
        prompt: 'Display name, for example "OpenRouter" or "My vLLM"',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Enter a name.'),
      });
      if (!name?.trim()) return;
      const baseUrl = await vscode.window.showInputBox({
        title: `${title} (2/5)`,
        prompt: 'API base URL',
        placeHolder: 'https://api.example.com/v1',
        ignoreFocusOut: true,
        validateInput: (value) => {
          try {
            const url = new URL(value.trim());
            return url.protocol === 'https:' || url.protocol === 'http:' ? undefined : 'Use an http(s) URL.';
          } catch {
            return 'Enter a full URL, for example https://api.example.com/v1.';
          }
        },
      });
      if (!baseUrl?.trim()) return;
      const format = await vscode.window.showQuickPick(
        API_FORMATS.map((value) => ({ label: value, description: API_FORMAT_HINTS[value] ?? '' })),
        { title: `${title} (3/5)`, placeHolder: 'Which API does the provider speak?', ignoreFocusOut: true },
      );
      if (!format) return;
      const models = await vscode.window.showInputBox({
        title: `${title} (4/5)`,
        prompt: 'Model IDs, separated by commas',
        placeHolder: 'gpt-5.1, my-model',
        ignoreFocusOut: true,
        validateInput: (value) => (value.split(',').some((model) => model.trim()) ? undefined : 'Enter at least one model ID.'),
      });
      if (!models?.trim()) return;
      const apiKey = await vscode.window.showInputBox({
        title: `${title} (5/5)`,
        prompt: 'API key (leave empty for providers that need none). It is handed to the CLI, which stores it.',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) return;
      const use = await vscode.window.showQuickPick(
        [
          { label: 'Test it and make it the default', description: 'Recommended', use: true },
          { label: 'Only add it', use: false },
        ],
        { title, placeHolder: 'Use this provider for new sessions?', ignoreFocusOut: true },
      );
      if (!use) return;
      await withProgress(`Adding ${name.trim()}${use.use ? ' and testing it' : ''}…`, async () => {
        await cli.providers.add(await runtime.cliContext(), {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiFormat: format.label,
          models: models.split(',').map((model) => model.trim()).filter(Boolean),
          ...(apiKey ? { apiKey } : {}),
          ...(use.use ? { use: true } : {}),
        });
      });
      refreshCapabilities();
      void account.refresh();
      void vscode.window.showInformationMessage(`${name.trim()} was added.`);
      await actions.afterAccountChange();
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
      await withProgress(`Removing ${node.provider.name}…`, async () => {
        await cli.providers.remove(await runtime.cliContext(), node.provider.providerId);
      });
      refreshCapabilities();
      void account.refresh();
      await actions.afterAccountChange();
    },
    'alran.providerTest': async (node: CapabilityNode) => {
      if (node.kind !== 'provider') return;
      const result = await vscode.window.withProgress(
        { location: { viewId: 'alran.capabilities' }, title: `Testing ${node.provider.name}…` },
        async () => cli.providers.test(await runtime.cliContext(), node.provider.providerId),
      );
      runtime.output.info(`provider test ${node.provider.providerId}: ${result.stdout.trim()} ${result.stderr.trim()}`);
      if (result.code === 0) void vscode.window.showInformationMessage(`${node.provider.name} answered. It works.`);
      else {
        const failure = describeFailure(cli.cliFailureMessage(result, ['provider', 'test']));
        void vscode.window.showErrorMessage(
          `${node.provider.name} did not answer: ${failure.title}.${failure.detail ? ` ${failure.detail}` : ''}`,
          'Show Logs',
        ).then((choice) => {
          if (choice) runtime.output.show();
        });
      }
    },
    'alran.providerUseSource': async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(account) Ottili account', detail: 'Model calls use your signed-in Ottili session.', value: 'token-plan' as const },
          { label: '$(key) Ottili API key', detail: 'Model calls use the saved Ottili API key and its project.', value: 'api-key' as const },
        ],
        { title: 'Ottili credentials', placeHolder: 'What should Alran use for Ottili models?' },
      );
      if (!picked) return;
      await cli.providers.use(await runtime.cliContext(), picked.value);
      refreshCapabilities();
      void account.refresh();
      await actions.afterAccountChange();
    },
    'alran.providerSetKey': async () => {
      if (await account.signInWithApiKey()) refreshCapabilities();
    },

    // Account and maintenance
    'alran.login': () => actions.login(),
    'alran.loginOptions': () => account.signInOptions(),
    'alran.loginWithDeviceCode': () => account.signIn({ flow: 'device', force: account.signedIn }),
    'alran.loginWithApiKey': () => account.signInWithApiKey(),
    'alran.logout': () => actions.logout(),
    'alran.switchCompany': () => account.switchCompany(),
    'alran.selectProject': () => account.selectProject(),
    'alran.pickDefaultModel': () => account.pickDefaultModel(),
    'alran.openBilling': () => account.openBilling(),
    'alran.refreshAccount': () => account.refresh({ usage: true }),
    'alran.accountUsage': async () => {
      await vscode.commands.executeCommand('alran.account.focus');
      await account.refresh({ usage: true });
    },
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
