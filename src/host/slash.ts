import * as vscode from 'vscode';

import { AGENT_HANDLED_COMMANDS, type SlashInvocation } from '../shared/commands';
import type { AlranActions } from './actions';
import type { StoreBrowser } from './store';

type Handler = (args: string) => Promise<void>;

/**
 * Implements every TUI slash command the agent does not answer over ACP.
 * Returns false when the command belongs to the agent (built-ins and Skills).
 */
export class SlashRouter {
  private readonly handlers: Readonly<Record<string, Handler>>;

  constructor(
    private readonly actions: AlranActions,
    private readonly views: { readonly focusCapabilities: () => Promise<void>; readonly focusAgents: () => Promise<void> },
    private readonly store: Pick<StoreBrowser, 'open'>,
  ) {
    const { actions: a } = this;
    const tui = (command: string): Handler => (args) =>
      a.openTui(args ? `/${command} ${args}` : `/${command}`);
    const session = () => a.active;
    this.handlers = {
      new: () => a.newSession(),
      clear: () => a.newSession(),
      sessions: (args) => a.pickSession(args),
      resume: (args) => a.pickSession(args),
      fork: () => a.fork(),
      btw: (args) => a.sideQuestion(args),
      side: (args) => a.sideQuestion(args),
      parent: () => a.returnToParent(),
      goal: (args) => a.goal(args),
      plan: (args) => a.plan(args),
      review: () => a.review(),
      retry: () => a.retry(),
      stop: () => a.cancel(),
      steer: async (text) => {
        if (!text) session()?.pushNotice('warning', 'Usage: /steer <message>');
        else if (!(await session()?.steer({ text, attachments: [] }))) {
          session()?.pushNotice('warning', 'No running turn to steer.');
        }
      },
      queue: async (text) => {
        if (!text) session()?.pushNotice('info', 'Queued messages are listed above the composer.');
        else if (session()?.busy) session()?.enqueue({ text, attachments: [] });
        else await session()?.submit({ text, attachments: [] });
      },
      permission: (args) => a.permissionCommand(args),
      export: (args) => a.exportSession(args),
      transcript: () => a.showTranscript(),
      copy: () => a.copyLastResponse(),
      tasks: async () => {
        await this.views.focusAgents();
        session()?.pushNotice(
          'info',
          'Sub-agents are listed in the Agents view. Background Bash tasks are only visible in the TUI: use the “Alran: Open Session in TUI” command.',
        );
      },
      provider: () => this.views.focusCapabilities(),
      plugin: (args) => this.store.open('plugins', args),
      plugins: (args) => this.store.open('plugins', args),
      store: (args) => this.store.open('plugins', args),
      login: () => a.login(),
      logout: () => a.logout(),
      update: () => a.update(),
      changelog: () => a.showChangelog(),
      settings: () => a.openSettings(),
      suggestions: () =>
        Promise.resolve(
          session()?.pushNotice(
            'info',
            'Next-message suggestions are a TUI feature; Alran does not generate them for ACP clients.',
          ),
        ),
      statusline: tui('statusline'),
      theme: tui('theme'),
      hotkeys: async () => {
        await vscode.commands.executeCommand(
          'workbench.action.openGlobalKeybindings',
          '@ext:ottili.alran-vscode',
        );
      },
      reload: () => a.restartAgent(),
      feedback: tui('feedback'),
      rewind: tui('rewind'),
      edit: tui('edit'),
      rename: tui('rename'),
      history: tui('history'),
      'add-dir': tui('add-dir'),
      mascot: () => a.mascot(),
      quit: () => a.closeTab(),
      exit: () => a.closeTab(),
    };
  }

  /** True when this command was handled here. */
  async dispatch(invocation: SlashInvocation): Promise<boolean> {
    // `/skills` lists the active Skills (the agent answers); `/skills library` is the Store's Skill Library.
    const library = /^library(?:\s+([\s\S]*))?$/iu.exec(invocation.args);
    if (invocation.name === 'skills' && library) {
      await this.actions.guarded(() => this.store.open('library', library[1]?.trim() ?? ''));
      return true;
    }
    if (AGENT_HANDLED_COMMANDS.has(invocation.name)) return false;
    const handler = this.handlers[invocation.name];
    if (!handler) return false;
    await this.actions.guarded(() => handler(invocation.args));
    return true;
  }
}
