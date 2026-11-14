import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type * as acp from '@agentclientprotocol/sdk';

import {
  errorMessage,
  isAuthRequired,
  type AlranAgent,
  type DelegationSnapshot,
  type GoalPatch,
  type RuntimeQueueItem,
} from '../acp/agent';
import { describeFailure, type FailureView } from '../shared/errors';
import { isRecord, SessionModel, toConfigViews, toModeViews } from '../shared/model';
import { AGENT_HANDLED_COMMANDS, parseSlash } from '../shared/commands';
import type {
  ComposerAttachment,
  DelegationMemberView,
  GoalView,
  PermissionItem,
  PromptInput,
  QuestionField,
  QuestionItem,
  SessionMeta,
  SessionSnapshot,
  SessionStatus,
  TranscriptItem,
  UserContent,
} from '../shared/types';
import { ChangeTracker } from './changes';

export type AttentionKind = 'permission' | 'question' | 'turn-complete' | 'turn-failed';

export interface AttentionEvent {
  readonly kind: AttentionKind;
  readonly sessionId: string;
  readonly title: string;
  readonly detail?: string;
  readonly itemId?: string;
}

export interface SessionListener {
  items(sessionId: string, items: readonly TranscriptItem[]): void;
  meta(meta: SessionMeta): void;
  snapshot(sessionId: string): void;
  changes(sessionId: string): void;
  attention(event: AttentionEvent): void;
  /** A turn started or ended, for the file watcher that attributes changes. */
  turn(sessionId: string, running: boolean): void;
  authRequired(): void;
  /** Diagnostics for the output channel. */
  log(line: string): void;
}

export interface SessionServices {
  readonly agent: () => AlranAgent;
  readonly listener: SessionListener;
  readonly mcpServers: () => acp.McpServer[];
  readonly enterWhileRunning: () => 'steer' | 'queue';
}

interface QueuedPrompt {
  readonly id: string;
  input: PromptInput;
}

interface PendingInteraction {
  readonly item: PermissionItem | QuestionItem;
  answer(result: { optionId?: string | null; label: string; action?: string; content?: Record<string, string | string[]> }): void;
}

const ACTIVE_TURN_PATTERN = /already has an active Turn/iu;
const ACTIVE_TURN_RETRY_ATTEMPTS = 10;
/** Quiet period after a turn in which trailing runtime events are not a new turn. */
const TRAILING_EVENT_WINDOW_MS = 1_500;
const RESYNC_INITIAL_DELAY_MS = 1_200;
const RESYNC_FINAL_DELAY_MS = 400;
const RESYNC_MAX_DELAY_MS = 20_000;
const RESYNC_MAX_ATTEMPTS = 200;

/** Conversation state and turn lifecycle of one open ACP Session. */
export class SessionController {
  readonly model: SessionModel;
  readonly changes = new ChangeTracker();
  private readonly queue: QueuedPrompt[] = [];
  private readonly interactions = new Map<string, PendingInteraction>();
  private promptActive = false;
  private cancelling = false;
  private loading = false;
  /** Replaying history: updates rebuild the transcript without reaching the UI. */
  private replaying = false;
  /** A turn the prompt request does not follow is running in the runtime. */
  private background = false;
  private resyncAttempts = 0;
  private detached = false;
  private lastInput: PromptInput | undefined;
  private lastTurnEndedAt = 0;
  private resyncTimer: NodeJS.Timeout | undefined;
  private capture: { text: string } | undefined;
  /** A runtime-queued turn was admitted during this prompt and will run after it. */
  private detachedTurnExpected = false;

  constructor(
    readonly id: string,
    cwd: string,
    private readonly services: SessionServices,
    options: { readonly isSide?: boolean; readonly title?: string } = {},
  ) {
    const meta: SessionMeta = {
      id,
      cwd,
      status: 'loading',
      modes: [],
      config: [],
      commands: [],
      delegation: [],
      queue: [],
      goalsEnabled: false,
      canRetry: false,
      ...(options.isSide ? { isSide: true } : {}),
      ...(options.title ? { title: options.title } : {}),
    };
    this.model = new SessionModel(meta);
  }

  get meta(): SessionMeta {
    return this.model.meta;
  }

  get snapshot(): SessionSnapshot {
    return { meta: this.model.meta, items: this.model.items };
  }

  get busy(): boolean {
    return this.promptActive;
  }

  get pendingInteractionCount(): number {
    return this.interactions.size;
  }

  /** Applies a `session/new`, `session/load`, or `session/fork` response. */
  applyControlState(state: {
    readonly modes?: acp.SessionModeState | null;
    readonly configOptions?: readonly acp.SessionConfigOption[] | null;
  }): void {
    if (state.modes) {
      this.meta.modes = toModeViews(state.modes);
      this.meta.currentModeId = state.modes.currentModeId;
    }
    if (state.configOptions) this.meta.config = toConfigViews(state.configOptions);
    this.emitMeta();
  }

  /**
   * Replays the persisted conversation into a fresh transcript. `silent` keeps
   * the current status, for background refreshes of a detached turn.
   */
  async attach(options: { readonly silent?: boolean } = {}): Promise<void> {
    this.loading = options.silent !== true;
    this.replaying = true;
    this.refreshStatus();
    try {
      this.model.reset();
      const response = await this.services
        .agent()
        .loadSession(this.id, this.meta.cwd, this.services.mcpServers());
      this.model.settle({ closeTools: false });
      this.applyControlState(response);
      this.detached = false;
    } finally {
      this.model.restoreClientItems();
      this.loading = false;
      this.replaying = false;
      this.refreshStatus();
      this.services.listener.snapshot(this.id);
    }
    await this.refreshExtensions();
  }

  markReady(): void {
    this.loading = false;
    this.detached = false;
    this.refreshStatus();
  }

  /** The agent process went away; everything in flight is over. */
  markDetached(reason: string): void {
    this.detached = true;
    this.loading = false;
    this.cancelling = false;
    this.background = false;
    clearTimeout(this.resyncTimer);
    for (const interaction of [...this.interactions.values()]) {
      interaction.answer({ optionId: null, label: 'Agent stopped' });
    }
    if (this.promptActive) {
      this.promptActive = false;
      this.emitItems(this.model.settle({ closeTools: true }));
      this.pushNotice('error', reason, { retryable: true });
      this.services.listener.turn(this.id, false);
    }
    this.refreshStatus();
  }

  async refreshExtensions(): Promise<void> {
    const agent = this.services.agent();
    const methods = agent.extensionMethods;
    this.meta.goalsEnabled = methods.has('alran/session/goal/get');
    const [goal, delegation] = await Promise.all([
      this.meta.goalsEnabled ? agent.getGoal(this.id).catch(() => undefined) : undefined,
      methods.has('alran/session/delegation/get')
        ? agent.getDelegation(this.id).catch(() => undefined)
        : undefined,
    ]);
    if (goal) this.meta.goal = toGoalView(goal.goal);
    if (delegation) this.meta.delegation = toDelegationViews(delegation.snapshot);
    this.emitMeta();
  }

  handleUpdate(update: acp.SessionUpdate): void {
    if (this.capture && update.sessionUpdate === 'agent_message_chunk') {
      if (update.content.type === 'text') this.capture.text += update.content.text;
      return;
    }
    const result = this.model.apply(update);
    if (result.metaChanged) this.emitMeta();
    if (this.replaying) return;
    if (result.items.length > 0) this.emitItems(result.items);
    for (const item of result.items) {
      if (item.kind === 'tool') void this.trackTool(item.id);
    }
    if (update.sessionUpdate === 'session_info_update' && typeof update.title !== 'string') {
      this.noteDetachedActivity(update.updatedAt);
    }
    // The runtime reports usage when a turn finishes, including detached ones.
    if (update.sessionUpdate === 'usage_update' && this.background && !this.promptActive) {
      this.finishDetachedTurn();
    }
  }

  handleRuntimeQueue(items: readonly RuntimeQueueItem[]): void {
    if (items.length === 0) return;
    if (this.promptActive) this.detachedTurnExpected = true;
    else this.startDetachedSync();
  }

  handleGoal(goal: unknown): void {
    this.meta.goal = toGoalView(goal);
    this.emitMeta();
  }

  handleDelegation(snapshot: DelegationSnapshot): void {
    this.meta.delegation = toDelegationViews(snapshot);
    this.emitMeta();
  }

  private noteDetachedActivity(updatedAt: string | null | undefined): void {
    if (this.promptActive || this.replaying || this.background) return;
    // Compare the runtime's own event time: a trailing event of the finished
    // turn can be delivered late, but it keeps the timestamp of when it happened.
    const eventTime = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    if (!Number.isFinite(eventTime) || eventTime - this.lastTurnEndedAt < TRAILING_EVENT_WINDOW_MS) return;
    this.startDetachedSync();
  }

  /**
   * Questionnaire continuations, runtime-queued turns and Goal runs execute
   * without a `session/prompt` request, so ACP does not stream them. Their
   * output only becomes visible by replaying the persisted history.
   */
  private startDetachedSync(): void {
    this.background = true;
    this.resyncAttempts = 0;
    this.refreshStatus();
    this.scheduleResync(RESYNC_INITIAL_DELAY_MS);
  }

  private finishDetachedTurn(): void {
    this.background = false;
    this.refreshStatus();
    this.scheduleResync(RESYNC_FINAL_DELAY_MS);
  }

  private scheduleResync(delayMs: number): void {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => void this.resync(), delayMs);
  }

  private async resync(): Promise<void> {
    if (this.promptActive || this.replaying) return;
    if (this.interactions.size > 0) {
      // Reattaching would deny the pending permission; wait for the answer.
      this.scheduleResync(RESYNC_INITIAL_DELAY_MS);
      return;
    }
    try {
      await this.attach({ silent: true });
    } catch {
      this.background = false;
      this.refreshStatus();
      return;
    }
    if (!this.background) return;
    this.resyncAttempts += 1;
    if (this.resyncAttempts >= RESYNC_MAX_ATTEMPTS) {
      this.background = false;
      this.refreshStatus();
      return;
    }
    this.scheduleResync(
      Math.min(RESYNC_INITIAL_DELAY_MS * 1.5 ** this.resyncAttempts, RESYNC_MAX_DELAY_MS),
    );
  }

  // Turn lifecycle ----------------------------------------------------------

  /** Sends now, or steers/queues when a turn is already running. */
  async submit(input: PromptInput, options: { readonly alternate?: boolean } = {}): Promise<void> {
    if (this.promptActive) {
      const preference = this.services.enterWhileRunning();
      const useSteer = options.alternate ? preference === 'queue' : preference === 'steer';
      if (useSteer && (await this.steer(input))) return;
      this.enqueue(input);
      return;
    }
    await this.runPrompt(input);
  }

  enqueue(input: PromptInput): void {
    this.queue.push({ id: randomUUID(), input });
    this.syncQueueView();
  }

  /** Delivers text into the running turn. Returns false when it could not be delivered. */
  async steer(input: PromptInput): Promise<boolean> {
    const text = flattenForSteer(input);
    if (text === undefined || !this.promptActive) return false;
    try {
      await this.services.agent().steer(this.id, text, randomUUID());
      this.emitItems([this.model.addUser(toUserContent(input), { steered: true })]);
      return true;
    } catch (error) {
      this.pushNotice('warning', `Could not steer the running turn: ${errorMessage(error)}`);
      return false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.promptActive) return;
    this.cancelling = true;
    this.refreshStatus();
    await this.services.agent().cancel(this.id);
  }

  async retry(): Promise<void> {
    if (this.lastInput && !this.promptActive) await this.runPrompt(this.lastInput);
  }

  private async runPrompt(input: PromptInput): Promise<void> {
    this.promptActive = true;
    // A background replay rebuilds the transcript; append only after it is done.
    while (this.replaying) await delay(25);
    this.lastInput = input;
    this.meta.canRetry = false;
    this.background = false;
    clearTimeout(this.resyncTimer);
    this.emitItems([this.model.addUser(toUserContent(input))]);
    const slash = input.attachments.length === 0 ? parseSlash(input.text) : undefined;
    this.model.expectPlainReply = slash !== undefined && AGENT_HANDLED_COMMANDS.has(slash.name) && slash.name !== 'compact';
    this.refreshStatus();
    this.services.listener.turn(this.id, true);
    let stopReason: string | undefined;
    let failure: unknown;
    try {
      stopReason = (await this.callPrompt(toPromptBlocks(input))).stopReason;
    } catch (error) {
      failure = error;
    }
    this.finishTurn(stopReason, failure);
    this.drainQueue(stopReason, failure);
  }

  private async callPrompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.services.agent().prompt(this.id, blocks);
      } catch (error) {
        // A detached continuation may still be finishing when the next prompt arrives.
        if (
          attempt >= ACTIVE_TURN_RETRY_ATTEMPTS ||
          this.cancelling ||
          !ACTIVE_TURN_PATTERN.test(errorMessage(error))
        ) {
          throw error;
        }
        await delay(300 * (attempt + 1));
      }
    }
  }

  private finishTurn(stopReason: string | undefined, failure: unknown): void {
    this.promptActive = false;
    this.cancelling = false;
    this.lastTurnEndedAt = Date.now();
    this.emitItems(this.model.settle({ closeTools: true }));
    this.services.listener.turn(this.id, false);
    void this.changes.pruneUnchanged().then((changed) => {
      if (changed) this.services.listener.changes(this.id);
    });
    if (this.detachedTurnExpected) {
      this.detachedTurnExpected = false;
      this.startDetachedSync();
    }

    if (failure !== undefined) {
      this.meta.canRetry = true;
      if (isAuthRequired(failure)) {
        this.pushNotice('error', 'Sign in to Alran Code to continue.', {
          authRequired: true,
          failure: {
            kind: 'auth',
            title: 'Sign in to continue',
            detail: 'Alran needs your Ottili account, or a model provider with your own API key. Your message is kept.',
            actions: ['sign-in', 'provider-settings'],
            retryable: true,
          },
        });
        this.services.listener.authRequired();
      } else {
        const message = errorMessage(failure);
        const view = describeFailure(message);
        this.services.listener.log(`turn failed: ${message}`);
        this.pushNotice('error', message, {
          retryable: view.retryable,
          ...(view.kind === 'auth' ? { authRequired: true } : {}),
          failure: view,
        });
        if (view.kind === 'auth') this.services.listener.authRequired();
        this.services.listener.attention({
          kind: 'turn-failed',
          sessionId: this.id,
          title: this.displayTitle,
          detail: view.title,
        });
      }
    } else if (stopReason === 'cancelled') {
      this.pushNotice('info', 'Stopped.');
    } else if (stopReason === 'max_turn_requests') {
      this.meta.canRetry = true;
      this.pushNotice('warning', 'The turn reached its step limit.', { retryable: true });
    } else if (stopReason === 'max_tokens') {
      this.pushNotice('warning', 'The response reached the model output limit.');
    } else if (stopReason === 'refusal') {
      this.pushNotice('warning', 'The model declined to continue.');
    } else if (this.queue.length === 0) {
      this.services.listener.attention({
        kind: 'turn-complete',
        sessionId: this.id,
        title: this.displayTitle,
      });
    }
    this.refreshStatus();
  }

  private drainQueue(stopReason: string | undefined, failure: unknown): void {
    // A stop or failure leaves the queue in place for the user to decide.
    if (failure !== undefined || stopReason === 'cancelled' || this.promptActive) return;
    const next = this.queue.shift();
    if (!next) return;
    this.syncQueueView();
    void this.runPrompt(next.input);
  }

  deleteQueued(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1);
    this.syncQueueView();
  }

  editQueued(id: string, text: string): void {
    const item = this.queue.find((candidate) => candidate.id === id);
    if (item) item.input = { ...item.input, text };
    this.syncQueueView();
  }

  clearQueue(): void {
    this.queue.length = 0;
    this.syncQueueView();
  }

  /** Delivers a queued message now: into the running turn, or as the next turn. */
  async sendQueuedNow(id: string): Promise<void> {
    const index = this.queue.findIndex((item) => item.id === id);
    const item = this.queue[index];
    if (!item) return;
    if (this.promptActive && !(await this.steer(item.input))) return;
    this.queue.splice(index, 1);
    this.syncQueueView();
    if (!this.promptActive) await this.runPrompt(item.input);
  }

  private syncQueueView(): void {
    this.meta.queue = this.queue.map((item) => ({
      id: item.id,
      text: item.input.text,
      attachmentCount: item.input.attachments.length,
    }));
    this.emitMeta();
  }

  /** Runs an agent slash command and returns its text without touching the transcript. */
  async captureCommand(text: string): Promise<string> {
    if (this.promptActive) throw new Error('The agent is busy with this session.');
    this.promptActive = true;
    this.capture = { text: '' };
    try {
      await this.services.agent().prompt(this.id, [{ type: 'text', text }]);
      return this.capture.text;
    } finally {
      this.capture = undefined;
      this.promptActive = false;
      this.lastTurnEndedAt = Date.now();
      this.refreshStatus();
    }
  }

  // Controls ----------------------------------------------------------------

  async setMode(modeId: string): Promise<void> {
    const response = await this.services.agent().setMode(this.id, modeId);
    const transition = response._meta?.['alran-code/transition'];
    if (transition === 'next_prompt') this.meta.pendingModeId = modeId;
    else {
      this.meta.pendingModeId = undefined;
      this.meta.currentModeId = modeId;
    }
    this.emitMeta();
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const response = await this.services.agent().setConfigOption(this.id, configId, value);
    this.meta.config = toConfigViews(response.configOptions);
    this.emitMeta();
  }

  async goalCreate(objective: string, tokenBudget?: number | null): Promise<void> {
    this.handleGoal((await this.services.agent().createGoal(this.id, objective, tokenBudget)).goal);
  }

  async goalPatch(patch: GoalPatch): Promise<void> {
    this.handleGoal((await this.services.agent().patchGoal(this.id, patch)).goal);
  }

  async goalClear(): Promise<void> {
    await this.services.agent().clearGoal(this.id);
    this.handleGoal(null);
  }

  async stopDelegation(): Promise<void> {
    await this.services.agent().stopDelegation(this.id);
  }

  // Permission and questionnaire requests -----------------------------------

  requestPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const { toolCall } = params;
    const item: PermissionItem = {
      kind: 'permission',
      id: this.model.allocateId('permission'),
      title: toolCall.title ?? 'Tool',
      ...(readName(toolCall) ? { toolName: readName(toolCall) } : {}),
      ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
      ...(toolCall.rawInput !== undefined ? { input: toolCall.rawInput } : {}),
      locations: (toolCall.locations ?? []).map((location) => location.path),
      options: params.options.map((option) => ({
        id: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      timestamp: Date.now(),
    };
    return new Promise((resolve) => {
      const answer: PendingInteraction['answer'] = ({ optionId, label }) => {
        if (item.resolution !== undefined) return;
        item.resolution = label;
        this.interactions.delete(item.id);
        signal.removeEventListener('abort', onAbort);
        this.emitItems([item]);
        this.refreshStatus();
        resolve(
          optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : { outcome: { outcome: 'cancelled' } },
        );
      };
      const onAbort = () => answer({ optionId: null, label: 'No longer needed' });
      signal.addEventListener('abort', onAbort, { once: true });
      this.interactions.set(item.id, { item, answer });
      this.model.push(item);
      // The request is the earliest sign of an edit; capture the pre-edit file now.
      for (const path of item.locations) void this.changes.observeTool(permissionAsTool(item, path));
      this.emitItems([item]);
      this.refreshStatus();
      this.services.listener.attention({
        kind: 'permission',
        sessionId: this.id,
        title: item.title,
        itemId: item.id,
      });
    });
  }

  answerPermission(id: string, optionId: string | null): void {
    const interaction = this.interactions.get(id);
    if (interaction?.item.kind !== 'permission') return;
    const option = interaction.item.options.find((candidate) => candidate.id === optionId);
    // An id that was never offered is not an answer: the agent would take it as a choice the user made.
    if (optionId !== null && !option) return;
    interaction.answer({ optionId, label: option?.name ?? 'Dismissed' });
  }

  requestElicitation(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> {
    if (params.mode !== 'form') return Promise.resolve({ action: 'cancel' });
    const item: QuestionItem = {
      kind: 'question',
      id: this.model.allocateId('question'),
      message: params.message,
      fields: toQuestionFields(params.requestedSchema as ElicitationSchema),
      timestamp: Date.now(),
    };
    return new Promise((resolve) => {
      const answer: PendingInteraction['answer'] = ({ action, content, label }) => {
        if (item.resolution !== undefined) return;
        item.resolution = label;
        this.interactions.delete(item.id);
        signal.removeEventListener('abort', onAbort);
        this.emitItems([item]);
        this.refreshStatus();
        resolve(
          action === 'accept'
            ? ({ action: 'accept', content: content ?? {} } as acp.CreateElicitationResponse)
            : { action: action === 'decline' ? 'decline' : 'cancel' },
        );
      };
      const onAbort = () => answer({ action: 'cancel', label: 'No longer needed' });
      signal.addEventListener('abort', onAbort, { once: true });
      this.interactions.set(item.id, { item, answer });
      this.model.push(item);
      this.emitItems([item]);
      this.refreshStatus();
      this.services.listener.attention({
        kind: 'question',
        sessionId: this.id,
        title: item.message,
        itemId: item.id,
      });
    });
  }

  answerQuestion(
    id: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | string[]>,
  ): void {
    const interaction = this.interactions.get(id);
    if (interaction?.item.kind !== 'question') return;
    if (action === 'accept') this.detachedTurnExpected = this.promptActive;
    if (action === 'accept' && !this.promptActive) this.startDetachedSync();
    interaction.answer({
      action,
      ...(content ? { content } : {}),
      label: action === 'accept' ? 'Answered' : 'Dismissed',
    });
  }

  // Helpers -----------------------------------------------------------------

  get displayTitle(): string {
    return this.meta.title?.trim() || 'New chat';
  }

  pushNotice(
    level: 'info' | 'warning' | 'error',
    text: string,
    options: {
      readonly retryable?: boolean;
      readonly authRequired?: boolean;
      readonly failure?: FailureView;
    } = {},
  ): void {
    const notice = this.model.push({
      kind: 'notice',
      id: this.model.allocateId('notice'),
      level,
      text,
      timestamp: Date.now(),
      ...(options.retryable ? { retryable: true } : {}),
      ...(options.authRequired ? { authRequired: true } : {}),
      ...(options.failure ? { failure: options.failure } : {}),
    });
    this.emitItems([notice]);
  }

  dispose(): void {
    clearTimeout(this.resyncTimer);
    for (const interaction of [...this.interactions.values()]) {
      interaction.answer({ optionId: null, label: 'Session closed', action: 'cancel' });
    }
  }

  /** Records a file changed on disk during this Session's running turn. */
  noteExternalChange(path: string): void {
    if (this.changes.observeExternalChange(path)) this.services.listener.changes(this.id);
  }

  private async trackTool(id: string): Promise<void> {
    const tool = this.model.findTool(id);
    if (tool && (await this.changes.observeTool(tool))) this.services.listener.changes(this.id);
  }

  private refreshStatus(): void {
    let status: SessionStatus;
    if (this.detached) status = 'detached';
    else if (this.loading) status = 'loading';
    else if (this.interactions.size > 0) status = 'awaiting-input';
    else if (this.cancelling) status = 'cancelling';
    else if (this.promptActive) status = 'running';
    else if (this.background) status = 'background';
    else status = 'idle';
    if (this.meta.status === status) return;
    this.meta.status = status;
    this.emitMeta();
  }

  private emitItems(items: readonly TranscriptItem[]): void {
    if (items.length > 0 && !this.replaying) this.services.listener.items(this.id, items);
  }

  private emitMeta(): void {
    this.services.listener.meta(this.meta);
  }
}

function permissionAsTool(item: PermissionItem, path: string) {
  return {
    kind: 'tool' as const,
    id: item.id,
    name: item.toolName ?? 'tool',
    title: item.title,
    toolKind: item.toolKind ?? 'other',
    status: 'pending' as const,
    blocks: [],
    locations: [path],
    timestamp: item.timestamp,
  };
}

function readName(toolCall: acp.ToolCallUpdate): string | undefined {
  const name = (toolCall as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toUserContent(input: PromptInput): UserContent[] {
  const content: UserContent[] = [];
  if (input.text) content.push({ type: 'text', text: input.text });
  for (const attachment of input.attachments) {
    if (attachment.kind === 'image') {
      content.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data });
    } else if (attachment.kind === 'file' || attachment.kind === 'selection') {
      content.push({
        type: 'resource',
        name: attachment.label,
        uri: pathToFileURL(attachment.path).href,
      });
    } else {
      content.push({ type: 'resource', name: attachment.label, uri: '' });
    }
  }
  return content;
}

function selectionBlock(attachment: Extract<ComposerAttachment, { kind: 'selection' }>): string {
  const fence = attachment.text.includes('```') ? '````' : '```';
  return `Selected lines ${String(attachment.startLine)}-${String(attachment.endLine)} of ${attachment.path}:\n${fence}${attachment.language}\n${attachment.text}\n${fence}`;
}

/**
 * ACP slash commands only match a single text block, so a bare slash command is
 * sent unchanged and everything else becomes text, links, and images.
 */
export function toPromptBlocks(input: PromptInput): acp.ContentBlock[] {
  const onlyCommand = parseSlash(input.text) && input.attachments.length === 0;
  if (onlyCommand) return [{ type: 'text', text: input.text }];
  const pluginLinks = input.attachments.flatMap((attachment) =>
    attachment.kind === 'plugin'
      ? [`[@${attachment.label}](plugin://${encodeURIComponent(attachment.pluginId)})`]
      : [],
  );
  const text = [pluginLinks.join(' '), input.text].filter(Boolean).join(' ');
  const blocks: acp.ContentBlock[] = text ? [{ type: 'text', text }] : [];
  for (const attachment of input.attachments) {
    switch (attachment.kind) {
      case 'file':
        blocks.push({
          type: 'resource_link',
          name: attachment.label,
          uri: pathToFileURL(attachment.path).href,
        });
        break;
      case 'selection':
        blocks.push({ type: 'text', text: selectionBlock(attachment) });
        break;
      case 'text':
        blocks.push({ type: 'text', text: attachment.text });
        break;
      case 'image':
        blocks.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data });
        break;
      case 'plugin':
        break;
    }
  }
  return blocks;
}

/** Steering takes plain text only; images must wait for the next turn. */
export function flattenForSteer(input: PromptInput): string | undefined {
  if (input.attachments.some((attachment) => attachment.kind === 'image')) return undefined;
  const parts = [input.text];
  for (const attachment of input.attachments) {
    if (attachment.kind === 'selection') parts.push(selectionBlock(attachment));
    else if (attachment.kind === 'text') parts.push(attachment.text);
    else if (attachment.kind === 'file') parts.push(`Referenced file: ${attachment.path}`);
    else if (attachment.kind === 'plugin') {
      parts.push(`[@${attachment.label}](plugin://${encodeURIComponent(attachment.pluginId)})`);
    }
  }
  const text = parts.filter(Boolean).join('\n\n');
  return text.trim() ? text : undefined;
}

interface ElicitationProperty {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly oneOf?: readonly { const: string; title?: string; description?: string }[];
  readonly items?: { readonly anyOf?: readonly { const: string; title?: string; description?: string }[] };
}

interface ElicitationSchema {
  readonly properties?: Record<string, ElicitationProperty>;
  readonly required?: readonly string[];
}

const OTHER_SUFFIX = /__other_*$/u;

/** Maps the form schema Alran generates for `ask_user` questionnaires. */
export function toQuestionFields(schema: ElicitationSchema): QuestionField[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const others = new Map<string, string>();
  for (const id of Object.keys(properties)) {
    const base = id.replace(OTHER_SUFFIX, '');
    if (base !== id && properties[base]) others.set(base, id);
  }
  const otherIds = new Set(others.values());
  return Object.entries(properties)
    .filter(([id]) => !otherIds.has(id))
    .map(([id, property]): QuestionField => {
      const multipleOptions = property.type === 'array' ? (property.items?.anyOf ?? []) : [];
      const singleOptions = property.oneOf ?? [];
      const choices = multipleOptions.length > 0 ? multipleOptions : singleOptions;
      const otherFieldId = others.get(id);
      return {
        id,
        title: property.title ?? id,
        ...(property.description ? { description: property.description } : {}),
        type: multipleOptions.length > 0 ? 'multiple' : singleOptions.length > 0 ? 'single' : 'text',
        options: choices.map((choice) => ({
          value: choice.const,
          label: choice.title ?? choice.const,
          ...(choice.description ? { description: choice.description } : {}),
        })),
        required: required.has(id),
        ...(otherFieldId ? { otherFieldId } : {}),
      };
    });
}

export function toGoalView(goal: unknown): GoalView | null {
  if (!isRecord(goal) || typeof goal.objective !== 'string') return null;
  return {
    ...(typeof goal.goalId === 'string' ? { goalId: goal.goalId } : {}),
    objective: goal.objective,
    status: typeof goal.status === 'string' ? goal.status : 'unknown',
    ...(goal.tokenBudget === null || typeof goal.tokenBudget === 'number'
      ? { tokenBudget: goal.tokenBudget }
      : {}),
    ...(typeof goal.tokensUsed === 'number' ? { tokensUsed: goal.tokensUsed } : {}),
  };
}

export function toDelegationViews(snapshot: DelegationSnapshot): DelegationMemberView[] {
  return snapshot.members.map((member) => ({
    sessionId: member.sessionId,
    parentSessionId: member.parentSessionId,
    title: member.task?.trim() || member.agentName || 'Sub-agent',
    status: member.status,
    ...(member.agentName ? { agentName: member.agentName } : {}),
  }));
}
