import type * as acp from '@agentclientprotocol/sdk';

import type {
  AssistantItem,
  CommandView,
  ConfigOptionView,
  ModeView,
  PlanItem,
  SessionMeta,
  ThoughtItem,
  ToolContentBlock,
  ToolItem,
  ToolStatus,
  TranscriptItem,
  UserContent,
  UserItem,
} from './types';

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/gu;
const PTC_TOOL_NAME = 'run_code';

export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER, '').trimEnd();
}

const QUESTIONNAIRE_RESPONSE = /<questionnaire-response>[\s\S]*?<\/questionnaire-response>\s*/gu;

/** A questionnaire answer replays as XML for the model plus a readable Q/A summary. */
export function cleanUserText(text: string): string {
  return stripSystemReminders(text).replace(QUESTIONNAIRE_RESPONSE, '').trim();
}

export interface ApplyResult {
  readonly items: readonly TranscriptItem[];
  readonly metaChanged: boolean;
}

/**
 * Applies ACP `session/update` notifications to one session's transcript. Pure
 * state: the extension host owns one instance per open session and forwards the
 * items that changed to the webviews.
 */
export class SessionModel {
  readonly items: TranscriptItem[] = [];
  private readonly toolIndex = new Map<string, ToolItem>();
  private readonly planIndex = new Map<string, PlanItem>();
  private nextId = 1;
  private readonly now: () => number;
  private retained: Array<{ item: TranscriptItem; usersBefore: number }> = [];
  /** The next assistant text answers a slash command, not a model turn. */
  expectPlainReply = false;

  constructor(
    readonly meta: SessionMeta,
    options: { readonly now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Discards the transcript before a history replay rebuilds it. Notices and
   * permission decisions exist only on this client, so they are set aside and
   * put back by `restoreClientItems`.
   */
  reset(): void {
    let usersBefore = 0;
    this.retained = this.items.flatMap((item) => {
      if (item.kind === 'user') usersBefore += 1;
      return item.kind === 'notice' || item.kind === 'permission' ? [{ item, usersBefore }] : [];
    });
    this.items.length = 0;
    this.toolIndex.clear();
    this.planIndex.clear();
  }

  /** Returns set-aside items to where they were, relative to the user messages. */
  restoreClientItems(): void {
    for (const { item, usersBefore } of this.retained) {
      let seen = 0;
      const next = this.items.findIndex((candidate) => {
        if (candidate.kind === 'user') seen += 1;
        return seen > usersBefore;
      });
      this.items.splice(next === -1 ? this.items.length : next, 0, item);
    }
    this.retained = [];
  }

  allocateId(prefix: string): string {
    const id = `${prefix}-${String(this.nextId)}`;
    this.nextId += 1;
    return id;
  }

  apply(update: acp.SessionUpdate): ApplyResult {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.applyChunk('assistant', update);
      case 'agent_thought_chunk':
        return this.applyChunk('thought', update);
      case 'user_message_chunk':
        return this.applyUserChunk(update);
      case 'tool_call':
        return { items: [this.applyToolCall(update)], metaChanged: false };
      case 'tool_call_update': {
        const item = this.applyToolUpdate(update);
        return { items: item ? [item] : [], metaChanged: false };
      }
      case 'plan':
        return {
          items: [this.upsertPlan('entries', { entries: update.entries })],
          metaChanged: false,
        };
      case 'plan_update':
        return this.applyPlanUpdate(update);
      case 'plan_removed': {
        const plan = this.planIndex.get(update.planId);
        if (!plan) return { items: [], metaChanged: false };
        plan.removed = true;
        return { items: [plan], metaChanged: false };
      }
      case 'available_commands_update':
        this.meta.commands = toCommandViews(update.availableCommands);
        return { items: [], metaChanged: true };
      case 'current_mode_update':
        this.meta.currentModeId = update.currentModeId;
        this.meta.pendingModeId = undefined;
        return { items: [], metaChanged: true };
      case 'config_option_update':
        this.meta.config = toConfigViews(update.configOptions);
        return { items: [], metaChanged: true };
      case 'session_info_update':
        if (typeof update.title === 'string') this.meta.title = update.title;
        if (typeof update.updatedAt === 'string') this.meta.updatedAt = update.updatedAt;
        return { items: [], metaChanged: true };
      case 'usage_update':
        this.meta.usage = {
          used: update.used,
          size: update.size,
          ...(update.cost?.currency === 'USD' ? { costUsd: update.cost.amount } : {}),
        };
        return { items: [], metaChanged: true };
      default:
        return { items: [], metaChanged: false };
    }
  }

  addUser(content: UserContent[], options: { readonly steered?: boolean } = {}): UserItem {
    const item: UserItem = {
      kind: 'user',
      id: this.allocateId('user'),
      content,
      timestamp: this.now(),
      ...(options.steered ? { steered: true } : {}),
    };
    this.items.push(item);
    return item;
  }

  push<T extends TranscriptItem>(item: T): T {
    this.items.push(item);
    return item;
  }

  find(id: string): TranscriptItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  findTool(id: string): ToolItem | undefined {
    return this.toolIndex.get(id);
  }

  tools(): readonly ToolItem[] {
    return [...this.toolIndex.values()];
  }

  /**
   * Marks streaming text as settled. With `closeTools`, tools a finished turn
   * left open become failed; a replay must keep them, the turn may still run.
   */
  settle(options: { readonly closeTools: boolean }): TranscriptItem[] {
    const changed: TranscriptItem[] = [];
    this.expectPlainReply = false;
    for (const item of this.items) {
      if ((item.kind === 'assistant' || item.kind === 'thought') && item.streaming) {
        item.streaming = false;
        changed.push(item);
      } else if (
        options.closeTools &&
        item.kind === 'tool' &&
        (item.status === 'pending' || item.status === 'in_progress')
      ) {
        item.status = 'failed';
        item.endedAt = this.now();
        if (!item.output) item.output = 'The turn ended before this tool finished.';
        changed.push(item);
      }
    }
    return changed;
  }

  lastAssistantText(): string | undefined {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (item?.kind === 'assistant' && item.text.trim()) return item.text;
    }
    return undefined;
  }

  private applyChunk(
    kind: 'assistant' | 'thought',
    update: { readonly messageId?: string | null; readonly content: acp.ContentBlock },
  ): ApplyResult {
    if (update.content.type !== 'text') return { items: [], metaChanged: false };
    const messageId = update.messageId ?? undefined;
    const last = this.items[this.items.length - 1];
    if (
      last?.kind === kind &&
      last.streaming &&
      (last.messageId === messageId || !last.messageId || !messageId)
    ) {
      last.text += update.content.text;
      if (messageId) last.messageId = messageId;
      return { items: [last], metaChanged: false };
    }
    const item: AssistantItem | ThoughtItem = {
      kind,
      id: this.allocateId(kind),
      ...(messageId ? { messageId } : {}),
      text: update.content.text,
      streaming: true,
      timestamp: this.now(),
      ...(kind === 'assistant' && this.expectPlainReply ? { plain: true } : {}),
    };
    this.items.push(item);
    return { items: [item], metaChanged: false };
  }

  private applyUserChunk(update: {
    readonly messageId?: string | null;
    readonly content: acp.ContentBlock;
  }): ApplyResult {
    const content = toUserContent(update.content);
    if (!content) return { items: [], metaChanged: false };
    const messageId = update.messageId ?? undefined;
    const last = this.items[this.items.length - 1];
    if (last?.kind === 'user' && messageId && last.messageId === messageId) {
      last.content.push(content);
      return { items: [last], metaChanged: false };
    }
    const item: UserItem = {
      kind: 'user',
      id: this.allocateId('user'),
      ...(messageId ? { messageId } : {}),
      content: [content],
      timestamp: this.now(),
    };
    this.items.push(item);
    return { items: [item], metaChanged: false };
  }

  private applyToolCall(update: acp.ToolCall): ToolItem {
    const existing = this.toolIndex.get(update.toolCallId);
    if (existing) {
      mergeTool(existing, update);
      this.finishIfTerminal(existing);
      return existing;
    }
    const name = readToolName(update);
    const parent = name === PTC_TOOL_NAME ? undefined : this.activePtcParent();
    const item: ToolItem = {
      kind: 'tool',
      id: update.toolCallId,
      name,
      title: update.title ?? name,
      toolKind: update.kind ?? 'other',
      status: update.status ?? 'pending',
      blocks: [],
      locations: [],
      timestamp: this.now(),
      ...(parent ? { parentId: parent.id } : {}),
    };
    mergeTool(item, update);
    this.finishIfTerminal(item);
    this.toolIndex.set(item.id, item);
    this.items.push(item);
    return item;
  }

  private applyToolUpdate(update: acp.ToolCallUpdate): ToolItem | undefined {
    const item = this.toolIndex.get(update.toolCallId);
    if (!item) {
      // An update can arrive for a call this client never saw, e.g. after a reload.
      return this.applyToolCall({
        toolCallId: update.toolCallId,
        title: update.title ?? 'tool',
        ...(update as Omit<acp.ToolCallUpdate, 'toolCallId' | 'title'>),
      } as acp.ToolCall);
    }
    mergeTool(item, update);
    this.finishIfTerminal(item);
    return item;
  }

  private finishIfTerminal(item: ToolItem): void {
    if ((item.status === 'completed' || item.status === 'failed') && item.endedAt === undefined) {
      item.endedAt = this.now();
    }
  }

  /**
   * Children of a `run_code` program carry their parent id only once finished.
   * Until then the running program is the only possible parent.
   */
  private activePtcParent(): ToolItem | undefined {
    for (const item of [...this.toolIndex.values()].reverse()) {
      if (item.name === PTC_TOOL_NAME && item.status === 'in_progress') return item;
    }
    return undefined;
  }

  private applyPlanUpdate(
    update: Extract<acp.SessionUpdate, { sessionUpdate: 'plan_update' }>,
  ): ApplyResult {
    const plan = update.plan as { type: string; planId?: string; content?: string; entries?: acp.PlanEntry[] };
    const key = plan.planId ?? 'plan';
    const item = this.upsertPlan(key, {
      ...(typeof plan.content === 'string' ? { markdown: plan.content } : {}),
      ...(plan.entries ? { entries: plan.entries } : {}),
    });
    return { items: [item], metaChanged: false };
  }

  private upsertPlan(
    key: string,
    content: { readonly markdown?: string; readonly entries?: readonly acp.PlanEntry[] },
  ): PlanItem {
    let plan = this.planIndex.get(key);
    if (!plan) {
      plan = { kind: 'plan', id: this.allocateId('plan'), timestamp: this.now() };
      this.planIndex.set(key, plan);
      this.items.push(plan);
    }
    if (content.markdown !== undefined) plan.markdown = content.markdown;
    if (content.entries) {
      plan.entries = content.entries.map((entry) => ({
        content: entry.content,
        priority: entry.priority,
        status: entry.status,
      }));
    }
    plan.removed = false;
    return plan;
  }
}

function readToolName(update: acp.ToolCall): string {
  const named = (update as { readonly name?: unknown }).name;
  return typeof named === 'string' && named ? named : (update.title ?? 'tool');
}

function mergeTool(item: ToolItem, update: acp.ToolCall | acp.ToolCallUpdate): void {
  if (update.title) item.title = update.title;
  if (update.kind) item.toolKind = update.kind;
  if (update.status) item.status = update.status as ToolStatus;
  if (update.rawInput !== undefined && update.rawInput !== null) item.input = update.rawInput;
  if (update.content) item.blocks = update.content.flatMap(toToolBlock);
  if (update.locations) item.locations = update.locations.map((location) => location.path);
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    const output = parseToolOutput(update.rawOutput);
    if (output.text !== undefined) item.output = output.text;
    if (output.patch) item.patch = output.patch;
    if (output.created) item.created = true;
    if (output.parentId) item.parentId = output.parentId;
  }
}

interface ParsedToolOutput {
  readonly text?: string;
  readonly patch?: string;
  readonly created?: boolean;
  readonly parentId?: string;
}

export function parseToolOutput(raw: unknown): ParsedToolOutput {
  if (typeof raw === 'string') return { text: stripSystemReminders(raw) };
  if (!isRecord(raw)) return {};
  const details = isRecord(raw.details) ? raw.details : undefined;
  const ptcRecord = isRecord(details?.ptc_child) ? details.ptc_child.record : undefined;
  const parentId = isRecord(ptcRecord) ? ptcRecord.parent_tool_call_id : undefined;
  const parts = Array.isArray(raw.content)
    ? raw.content.flatMap((part: unknown) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
      )
    : [];
  const fromError = typeof raw.error === 'string' ? raw.error : undefined;
  const joined = parts.length > 0 ? parts.join('\n') : fromError;
  return {
    ...(joined !== undefined ? { text: stripSystemReminders(joined) } : {}),
    ...(typeof details?.patch === 'string' ? { patch: details.patch } : {}),
    ...(details?.created === true ? { created: true } : {}),
    ...(typeof parentId === 'string' ? { parentId } : {}),
  };
}

function toToolBlock(content: acp.ToolCallContent): ToolContentBlock[] {
  if (content.type === 'diff') {
    return [
      {
        type: 'diff',
        path: content.path,
        ...(content.oldText != null ? { oldText: content.oldText } : {}),
        newText: content.newText,
      },
    ];
  }
  if (content.type === 'content') {
    if (content.content.type === 'text') return [{ type: 'text', text: content.content.text }];
    if (content.content.type === 'image') {
      return [{ type: 'image', mimeType: content.content.mimeType, data: content.content.data }];
    }
  }
  return [];
}

function toUserContent(block: acp.ContentBlock): UserContent | undefined {
  if (block.type === 'text') {
    const text = cleanUserText(block.text);
    return text ? { type: 'text', text } : undefined;
  }
  if (block.type === 'image') return { type: 'image', mimeType: block.mimeType, data: block.data };
  if (block.type === 'resource_link') {
    return { type: 'resource', name: block.title ?? block.name, uri: block.uri };
  }
  return undefined;
}

export function toCommandViews(commands: readonly acp.AvailableCommand[]): CommandView[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description.replace(/^\[Skill\]\s*/u, ''),
    ...(command.input && 'hint' in command.input && command.input.hint
      ? { hint: command.input.hint }
      : {}),
    source: command.description.startsWith('[Skill]') ? ('skill' as const) : ('agent' as const),
  }));
}

export function toModeViews(state: acp.SessionModeState | null | undefined): ModeView[] {
  return (state?.availableModes ?? []).map((mode) => ({
    id: mode.id,
    name: mode.name,
    ...(mode.description ? { description: mode.description } : {}),
  }));
}

export function toConfigViews(
  options: readonly acp.SessionConfigOption[] | null | undefined,
): ConfigOptionView[] {
  return (options ?? []).flatMap((option): ConfigOptionView[] => {
    if (option.type !== 'select') return [];
    const flat = option.options.flatMap((entry) =>
      'value' in entry
        ? [{ value: entry.value, name: entry.name }]
        : entry.options.map((nested) => ({ value: nested.value, name: nested.name })),
    );
    return [
      {
        id: option.id,
        name: option.name,
        ...(option.description ? { description: option.description } : {}),
        ...(option.category ? { category: option.category } : {}),
        currentValue: option.currentValue,
        options: flat,
      },
    ];
  });
}

/** One-line human title for a tool row, from the tool name and its input. */
export function describeTool(item: Pick<ToolItem, 'name' | 'title' | 'input' | 'locations'>): string {
  const input = isRecord(item.input) ? item.input : {};
  const path = firstString(input.file_path, input.path, input.filePath, item.locations[0]);
  const shortPath = path ? shortenPath(path) : undefined;
  switch (item.name.toLowerCase()) {
    case 'read':
      return shortPath ? `Read ${shortPath}` : 'Read';
    case 'write':
      return shortPath ? `Write ${shortPath}` : 'Write';
    case 'edit':
    case 'multi_edit':
      return shortPath ? `Edit ${shortPath}` : 'Edit';
    case 'bash':
      return firstString(input.description) ?? `Run ${firstString(input.command) ?? 'command'}`;
    case 'grep':
      return `Search ${firstString(input.pattern) ?? ''}`.trim();
    case 'glob':
      return `Find ${firstString(input.pattern) ?? 'files'}`;
    case 'run_code':
      return firstString(input.description) ?? 'Run program';
    case 'task':
      return firstString(input.description, input.title) ?? 'Delegate to a sub-agent';
    case 'skill':
      return `Use skill ${firstString(input.name, input.skill) ?? ''}`.trim();
    case 'ask_user':
      return 'Ask a question';
    default:
      return item.title && item.title !== item.name ? item.title : item.name;
  }
}

export function shortenPath(path: string, segments = 2): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.length <= segments ? path : `…/${parts.slice(-segments).join('/')}`;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
