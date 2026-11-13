import * as vscode from 'vscode';

import { errorMessage } from '../acp/agent';
import { AlranCliNotFoundError } from '../acp/binary';
import { AuthRequiredError } from '../core/manager';
import type { SessionController } from '../core/session';
import type { FailureAction } from '../shared/errors';
import { describeTool } from '../shared/model';
import type { ComposerAttachment, TranscriptItem } from '../shared/types';
import { REVIEW_PROMPT } from './actions';
import type { AlranRuntime } from './runtime';

export const PARTICIPANT_ID = 'alran.agent';

interface AlranChatResultMetadata {
  readonly alranSessionId?: string;
  readonly cwd?: string;
}

const FAILURE_COMMANDS: Partial<Record<FailureAction, readonly [string, string]>> = {
  'sign-in': ['alran.login', 'Sign in'],
  'add-credits': ['alran.openBilling', 'Add credit'],
  'show-usage': ['alran.accountUsage', 'Show usage'],
  'switch-model': ['alran.pickModel', 'Choose another model'],
  'use-werk': ['alran.useWerk', 'Switch to Ottili Werk'],
  'provider-settings': ['alran.capabilities.focus', 'Provider settings'],
  'show-logs': ['alran.showLogs', 'Show logs'],
  'new-session': ['alran.newSession', 'New session'],
};

/**
 * `@alran` in the editor's own Chat view. Each chat conversation maps to one
 * Alran session (its id travels in the result metadata), so follow-ups keep
 * their context and the conversation can continue in the Alran chat.
 */
export class AlranChatParticipant {
  constructor(private readonly runtime: AlranRuntime) {}

  readonly handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    let session: SessionController;
    try {
      session = await this.sessionFor(request, context);
    } catch (error) {
      this.reportStartFailure(error, stream);
      return { errorDetails: { message: errorMessage(error) } };
    }
    const metadata: AlranChatResultMetadata = { alranSessionId: session.id, cwd: session.meta.cwd };
    if (request.command === 'new') {
      stream.markdown('Started a new Alran session. Ask away.');
      return { metadata };
    }
    if (session.busy) {
      stream.markdown('This Alran session is still working on something else. ');
      stream.button({ command: 'alran.openChat', title: 'Open the Alran chat' });
      return { metadata };
    }
    const text = request.command === 'review' ? REVIEW_PROMPT : request.prompt.trim();
    if (!text) {
      stream.markdown('Tell Alran what to do, for example `@alran add a test for the date parser`.');
      return { metadata };
    }
    const renderer = new StreamRenderer(session, stream, this.runtime.manager.sessions.size);
    const listener = this.runtime.onDidChangeItems(({ sessionId, items }) => {
      if (sessionId === session.id) renderer.render(items);
    });
    const cancel = token.onCancellationRequested(() => void session.cancel().catch(() => undefined));
    try {
      await session.submit({ text, attachments: await referencesToAttachments(request.references) });
      renderer.render(session.model.items.slice(renderer.startIndex));
    } finally {
      listener.dispose();
      cancel.dispose();
    }
    renderer.finish();
    return { metadata };
  };

  /** The session of this conversation: from earlier results, else a fresh one. */
  private async sessionFor(request: vscode.ChatRequest, context: vscode.ChatContext): Promise<SessionController> {
    const { manager } = this.runtime;
    if (request.command !== 'new') {
      for (const turn of [...context.history].reverse()) {
        if (!(turn instanceof vscode.ChatResponseTurn) || turn.participant !== PARTICIPANT_ID) continue;
        const previous = turn.result.metadata as AlranChatResultMetadata | undefined;
        if (!previous?.alranSessionId) continue;
        const open = manager.sessions.get(previous.alranSessionId);
        if (open && open.meta.status !== 'detached') return open;
        try {
          return await manager.openSession(previous.alranSessionId, previous.cwd ?? this.runtime.defaultCwd(), undefined, {
            activate: false,
          });
        } catch (error) {
          if (error instanceof AuthRequiredError) throw error;
          break;
        }
      }
    }
    await this.runtime.restoreTabs().catch(() => undefined);
    return manager.newSession(this.runtime.defaultCwd(), { activate: false });
  }

  private reportStartFailure(error: unknown, stream: vscode.ChatResponseStream): void {
    if (error instanceof AlranCliNotFoundError) {
      stream.markdown('The Alran Code CLI is not installed on this machine yet.\n\n');
      stream.button({ command: 'alran.installCli', title: 'Install Alran' });
    } else if (error instanceof AuthRequiredError) {
      stream.markdown('Sign in to your Ottili account, or add your own model provider, to use Alran.\n\n');
      stream.button({ command: 'alran.login', title: 'Sign in' });
      stream.button({ command: 'alran.loginOptions', title: 'Other options' });
    } else {
      stream.markdown(`Alran could not start: ${errorMessage(error)}\n\n`);
      stream.button({ command: 'alran.showLogs', title: 'Show logs' });
    }
  }
}

/** Streams one turn of a session into a chat response. */
class StreamRenderer {
  readonly startIndex: number;
  private readonly emitted = new Map<string, number>();
  private readonly announced = new Set<string>();
  private wroteText = false;
  private lastKind: TranscriptItem['kind'] | undefined;

  constructor(
    private readonly session: SessionController,
    private readonly stream: vscode.ChatResponseStream,
    private readonly openSessions: number,
  ) {
    this.startIndex = session.model.items.length;
  }

  render(items: readonly TranscriptItem[]): void {
    for (const item of items) {
      switch (item.kind) {
        case 'assistant': {
          const done = this.emitted.get(item.id) ?? 0;
          if (item.text.length > done) {
            if (done === 0 && this.wroteText && this.lastKind !== 'assistant') this.stream.markdown('\n\n');
            this.stream.markdown(item.text.slice(done));
            this.emitted.set(item.id, item.text.length);
            this.wroteText = true;
            this.lastKind = 'assistant';
          }
          break;
        }
        case 'tool': {
          if (item.parentId) break;
          if (!this.announced.has(item.id)) {
            this.announced.add(item.id);
            this.stream.progress(describeTool(item));
          }
          if ((item.status === 'completed' || item.status === 'failed') && !this.announced.has(`${item.id}:done`)) {
            this.announced.add(`${item.id}:done`);
            if (item.toolKind === 'edit' || item.toolKind === 'delete' || item.toolKind === 'move') {
              for (const location of item.locations) this.stream.reference(vscode.Uri.file(location));
            }
            if (item.status === 'failed') {
              this.stream.markdown(new vscode.MarkdownString(`\n\n$(error) ${describeTool(item)} failed\n\n`, true));
              this.lastKind = 'tool';
            }
          }
          break;
        }
        case 'permission': {
          if (item.resolution !== undefined || this.announced.has(item.id)) break;
          this.announced.add(item.id);
          this.stream.markdown(`\n\n**Alran needs your permission:** ${item.title}\n\n`);
          for (const option of item.options) {
            this.stream.button({
              command: 'alran.answerPermission',
              title: option.name,
              arguments: [this.session.id, item.id, option.id],
            });
          }
          this.lastKind = 'permission';
          break;
        }
        case 'question': {
          if (item.resolution !== undefined || this.announced.has(item.id)) break;
          this.announced.add(item.id);
          this.stream.markdown(`\n\n**Alran asks:** ${item.message}\n\n`);
          this.stream.button({ command: 'alran.showSession', title: 'Answer in the Alran chat', arguments: [this.session.id] });
          this.lastKind = 'question';
          break;
        }
        case 'plan': {
          if (this.announced.has(item.id) || item.removed) break;
          this.announced.add(item.id);
          this.stream.button({ command: 'alran.showSession', title: 'View the plan', arguments: [this.session.id] });
          break;
        }
        case 'notice': {
          if (this.announced.has(item.id)) break;
          this.announced.add(item.id);
          if (item.failure) {
            const { failure } = item;
            this.stream.markdown(
              new vscode.MarkdownString(`\n\n$(warning) **${failure.title}**${failure.detail ? ` — ${failure.detail}` : ''}\n\n`, true),
            );
            for (const action of failure.actions) {
              const command = FAILURE_COMMANDS[action];
              if (!command) continue;
              const sessionScoped = action === 'use-werk' || action === 'switch-model';
              this.stream.button({
                command: command[0],
                title: command[1],
                ...(sessionScoped ? { arguments: [this.session.id] } : {}),
              });
            }
          } else if (item.level !== 'info') {
            this.stream.markdown(`\n\n_${item.text}_\n\n`);
          }
          this.lastKind = 'notice';
          break;
        }
        default:
          break;
      }
    }
  }

  finish(): void {
    if (!this.wroteText && this.lastKind === undefined) this.stream.markdown('Done.');
    // The same session is a tab in the Alran chat, with diffs, revert and history.
    this.stream.button({
      command: 'alran.showSession',
      title: this.openSessions > 0 ? 'Continue in the Alran chat' : 'Open in the Alran chat',
      arguments: [this.session.id],
    });
  }
}

async function referencesToAttachments(references: readonly vscode.ChatPromptReference[]): Promise<ComposerAttachment[]> {
  const attachments: ComposerAttachment[] = [];
  for (const [index, reference] of references.entries()) {
    const value = reference.value;
    if (value instanceof vscode.Uri && value.scheme === 'file') {
      attachments.push({
        kind: 'file',
        id: `chat-${String(index)}`,
        path: value.fsPath,
        label: vscode.workspace.asRelativePath(value, false),
      });
    } else if (value instanceof vscode.Location && value.uri.scheme === 'file') {
      const document = await vscode.workspace.openTextDocument(value.uri);
      attachments.push({
        kind: 'selection',
        id: `chat-${String(index)}`,
        path: value.uri.fsPath,
        label: `${vscode.workspace.asRelativePath(value.uri, false)}:${String(value.range.start.line + 1)}-${String(value.range.end.line + 1)}`,
        text: document.getText(value.range),
        language: document.languageId,
        startLine: value.range.start.line + 1,
        endLine: value.range.end.line + 1,
      });
    } else if (typeof value === 'string' && value.trim()) {
      attachments.push({ kind: 'text', id: `chat-${String(index)}`, label: reference.id, text: value });
    }
  }
  return attachments;
}

/** Registers `@alran` where the editor has a Chat view (VS Code; not every fork does). */
export function registerChatParticipant(runtime: AlranRuntime, extensionUri: vscode.Uri): {
  readonly participant?: AlranChatParticipant;
  readonly disposable: vscode.Disposable;
} {
  const chat = (vscode as { chat?: typeof vscode.chat }).chat;
  if (typeof chat?.createChatParticipant !== 'function') return { disposable: new vscode.Disposable(() => undefined) };
  const participant = new AlranChatParticipant(runtime);
  try {
    const registered = chat.createChatParticipant(PARTICIPANT_ID, participant.handler);
    registered.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    registered.followupProvider = {
      provideFollowups: (result) =>
        (result.metadata as AlranChatResultMetadata | undefined)?.alranSessionId
          ? [
              { prompt: 'Review the changes you just made', label: 'Review these changes' },
              { prompt: 'Run the tests and fix what fails', label: 'Run the tests' },
            ]
          : [],
    };
    return { participant, disposable: registered };
  } catch (error) {
    runtime.output.warn(`@alran is not available in this editor's chat: ${errorMessage(error)}`);
    return { disposable: new vscode.Disposable(() => undefined) };
  }
}
