/**
 * View model shared by the extension host and the chat webview. This module and
 * everything else in `src/shared` must stay free of `vscode` and Node imports.
 */

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolContentBlock =
  | { readonly type: 'diff'; readonly path: string; readonly oldText?: string; readonly newText: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string };

export type UserContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource'; readonly name: string; readonly uri: string };

export interface UserItem {
  readonly kind: 'user';
  readonly id: string;
  messageId?: string;
  content: UserContent[];
  /** Set for prompts delivered with `alran/session/steer` into a running turn. */
  steered?: boolean;
  timestamp: number;
}

export interface AssistantItem {
  readonly kind: 'assistant';
  readonly id: string;
  messageId?: string;
  text: string;
  streaming: boolean;
  /** Plain-text output of an agent slash command, shown preformatted. */
  plain?: boolean;
  timestamp: number;
}

export interface ThoughtItem {
  readonly kind: 'thought';
  readonly id: string;
  messageId?: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

export interface ToolItem {
  readonly kind: 'tool';
  readonly id: string;
  name: string;
  title: string;
  toolKind: string;
  status: ToolStatus;
  input?: unknown;
  /** Display text extracted from the raw tool result, without runtime reminders. */
  output?: string;
  /** Real unified diff from the tool result, when the tool produced one. */
  patch?: string;
  /** `details.created` from a write: the file did not exist before this call. */
  created?: boolean;
  blocks: ToolContentBlock[];
  locations: string[];
  /** Enclosing `run_code` call for Programmatic Tool Calling children. */
  parentId?: string;
  timestamp: number;
  endedAt?: number;
}

export interface PermissionOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface PermissionItem {
  readonly kind: 'permission';
  readonly id: string;
  title: string;
  toolName?: string;
  toolKind?: string;
  input?: unknown;
  locations: string[];
  options: PermissionOption[];
  /** Set once answered; the label of the chosen option, or why it went away. */
  resolution?: string;
  timestamp: number;
}

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionField {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly type: 'single' | 'multiple' | 'text';
  readonly options: readonly QuestionOption[];
  readonly required: boolean;
  /** Free-text companion field for "Other" answers on a choice question. */
  readonly otherFieldId?: string;
}

export interface QuestionItem {
  readonly kind: 'question';
  readonly id: string;
  message: string;
  fields: QuestionField[];
  resolution?: string;
  timestamp: number;
}

export interface PlanEntryView {
  readonly content: string;
  readonly priority?: string;
  readonly status?: string;
}

export interface PlanItem {
  readonly kind: 'plan';
  readonly id: string;
  markdown?: string;
  entries?: PlanEntryView[];
  removed?: boolean;
  timestamp: number;
}

export interface NoticeItem {
  readonly kind: 'notice';
  readonly id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  /** Offers a Retry button that resends the last prompt. */
  retryable?: boolean;
  /** Offers a sign-in button. */
  authRequired?: boolean;
  timestamp: number;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThoughtItem
  | ToolItem
  | PermissionItem
  | QuestionItem
  | PlanItem
  | NoticeItem;

export type SessionStatus =
  | 'loading'
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'awaiting-input'
  | 'background'
  | 'detached';

export interface ModeView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ConfigChoice {
  readonly value: string;
  readonly name: string;
}

export interface ConfigOptionView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly currentValue: string;
  readonly options: readonly ConfigChoice[];
}

export interface CommandView {
  readonly name: string;
  readonly description: string;
  readonly hint?: string;
  readonly source: 'agent' | 'skill' | 'client';
}

export interface UsageView {
  readonly used: number;
  readonly size: number;
  readonly costUsd?: number;
}

export interface GoalView {
  readonly goalId?: string;
  readonly objective: string;
  readonly status: string;
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number;
}

export interface DelegationMemberView {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly title: string;
  readonly status: string;
  readonly agentName?: string;
}

export interface QueuedPromptView {
  readonly id: string;
  readonly text: string;
  readonly attachmentCount: number;
}

export interface SessionMeta {
  readonly id: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  status: SessionStatus;
  currentModeId?: string;
  /** Mode switch requested while a turn runs or waiting for the next prompt. */
  pendingModeId?: string;
  modes: ModeView[];
  config: ConfigOptionView[];
  commands: CommandView[];
  usage?: UsageView;
  goal?: GoalView | null;
  goalsEnabled: boolean;
  delegation: DelegationMemberView[];
  queue: QueuedPromptView[];
  isSide?: boolean;
  canRetry: boolean;
}

export interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly items: readonly TranscriptItem[];
}

export type ConnectionState =
  | { readonly state: 'disconnected'; readonly detail?: string }
  | { readonly state: 'connecting' }
  | { readonly state: 'connected'; readonly version?: string }
  | { readonly state: 'auth-required'; readonly detail?: string }
  | { readonly state: 'missing-binary'; readonly detail?: string }
  | { readonly state: 'error'; readonly detail: string };

export interface TabView {
  readonly id: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly isSide?: boolean;
}

export type ComposerAttachment =
  | {
      readonly kind: 'file';
      readonly id: string;
      readonly path: string;
      readonly label: string;
    }
  | {
      readonly kind: 'selection';
      readonly id: string;
      readonly path: string;
      readonly label: string;
      readonly text: string;
      readonly language: string;
      readonly startLine: number;
      readonly endLine: number;
    }
  | {
      readonly kind: 'text';
      readonly id: string;
      readonly label: string;
      readonly text: string;
    }
  | {
      readonly kind: 'image';
      readonly id: string;
      readonly label: string;
      readonly mimeType: string;
      readonly data: string;
    }
  | {
      readonly kind: 'plugin';
      readonly id: string;
      readonly label: string;
      readonly pluginId: string;
    };

export interface MentionCandidate {
  readonly kind: 'file' | 'plugin';
  readonly label: string;
  readonly detail?: string;
  readonly value: string;
}

export interface PromptInput {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
}

export interface ChatPreferences {
  readonly enterWhileRunning: 'steer' | 'queue';
  readonly showThinking: boolean;
  readonly includeActiveFile: boolean;
  readonly sendShortcut: 'enter' | 'ctrlEnter';
}
