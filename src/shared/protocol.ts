import type { FailureAction } from './errors';
import type {
  AccountView,
  ChatPreferences,
  ComposerAttachment,
  ConnectionState,
  MentionCandidate,
  SessionMeta,
  SessionSnapshot,
  TabView,
  TranscriptItem,
} from './types';

/** Messages from the extension host to a chat webview. */
export type HostMessage =
  | { readonly type: 'connection'; readonly connection: ConnectionState }
  | { readonly type: 'tabs'; readonly tabs: readonly TabView[]; readonly activeId?: string }
  | { readonly type: 'snapshot'; readonly snapshot: SessionSnapshot | null }
  | { readonly type: 'items'; readonly sessionId: string; readonly items: readonly TranscriptItem[] }
  | { readonly type: 'meta'; readonly meta: SessionMeta }
  | { readonly type: 'preferences'; readonly preferences: ChatPreferences }
  | { readonly type: 'activeFile'; readonly label?: string }
  | {
      readonly type: 'mentions';
      readonly requestId: number;
      readonly candidates: readonly MentionCandidate[];
    }
  | { readonly type: 'addAttachments'; readonly attachments: readonly ComposerAttachment[] }
  | { readonly type: 'setDraft'; readonly text: string; readonly send?: boolean }
  | { readonly type: 'focusComposer' }
  | { readonly type: 'account'; readonly account: AccountView };

export type QueueOperation =
  | { readonly op: 'delete'; readonly id: string }
  | { readonly op: 'edit'; readonly id: string; readonly text: string }
  | { readonly op: 'steer'; readonly id: string }
  | { readonly op: 'clear' };

export type GoalOperation =
  | { readonly op: 'create'; readonly objective: string; readonly tokenBudget?: number | null }
  | { readonly op: 'pause' }
  | { readonly op: 'resume' }
  | { readonly op: 'edit'; readonly objective: string }
  | { readonly op: 'budget'; readonly tokenBudget: number | null }
  | { readonly op: 'clear' };

/** Messages from a chat webview to the extension host. */
export type WebviewMessage =
  | { readonly type: 'ready' }
  | {
      readonly type: 'send';
      readonly text: string;
      readonly attachments: readonly ComposerAttachment[];
      /** `alternate` picks the non-default busy behaviour (steer vs. queue). */
      readonly alternate?: boolean;
      readonly includeActiveFile: boolean;
    }
  | { readonly type: 'cancel' }
  | { readonly type: 'retry' }
  | { readonly type: 'newSession' }
  | { readonly type: 'activateTab'; readonly id: string }
  | { readonly type: 'closeTab'; readonly id: string }
  | { readonly type: 'setMode'; readonly modeId: string }
  | { readonly type: 'setConfig'; readonly configId: string; readonly value: string }
  | { readonly type: 'cycleMode' }
  | { readonly type: 'cyclePermission' }
  | { readonly type: 'permission'; readonly id: string; readonly optionId: string | null }
  | {
      readonly type: 'question';
      readonly id: string;
      readonly action: 'accept' | 'decline' | 'cancel';
      readonly content?: Record<string, string | string[]>;
    }
  | { readonly type: 'mentionQuery'; readonly requestId: number; readonly query: string }
  | { readonly type: 'pickAttachment' }
  | { readonly type: 'openFile'; readonly path: string; readonly line?: number }
  | { readonly type: 'openToolDiff'; readonly toolId: string }
  | { readonly type: 'previewPermissionDiff'; readonly id: string }
  | { readonly type: 'openPlan'; readonly id: string }
  | { readonly type: 'copy'; readonly text: string }
  | { readonly type: 'insertAtCursor'; readonly text: string }
  | { readonly type: 'applyToNewFile'; readonly text: string; readonly language?: string }
  | { readonly type: 'runInTerminal'; readonly text: string }
  | { readonly type: 'queue'; readonly operation: QueueOperation }
  | { readonly type: 'goal'; readonly operation: GoalOperation }
  | { readonly type: 'stopDelegation' }
  | { readonly type: 'openSubagent'; readonly sessionId: string }
  | { readonly type: 'signIn'; readonly method?: 'default' | 'options' | 'api-key' | 'provider' }
  | { readonly type: 'failureAction'; readonly action: FailureAction }
  | { readonly type: 'command'; readonly command: string; readonly args?: readonly unknown[] };
