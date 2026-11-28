import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OUTPUT_RATE_NOTIFICATION, type AlranAgent, type RuntimeQueueItem } from '../../src/acp/agent';
import { SessionController } from '../../src/core/session';

function createSession(options: {
  notifications?: readonly string[];
  runtimeQueue?: boolean;
  queueItems?: RuntimeQueueItem[];
} = {}) {
  const loadSession = vi.fn().mockResolvedValue({});
  const queueItems = [...(options.queueItems ?? [])];
  const queueMethods = [
    'alran/session/queue/list',
    'alran/session/queue/enqueue',
    'alran/session/queue/update',
    'alran/session/queue/delete',
    'alran/session/queue/steer',
  ];
  const listQueued = vi.fn(async () => ({ items: [...queueItems] }));
  const enqueueQueued = vi.fn(async (sessionId: string, text: string) => {
    const item = { itemId: `q${String(queueItems.length + 1)}`, sessionId, status: 'queued', content: text };
    queueItems.push(item);
    return { itemId: item.itemId, status: item.status };
  });
  const updateQueued = vi.fn(async (sessionId: string, itemId: string, text: string) => {
    const index = queueItems.findIndex((item) => item.itemId === itemId && item.sessionId === sessionId);
    if (index < 0) return { item: null };
    const item = { ...queueItems[index]!, content: text };
    queueItems[index] = item;
    return { item };
  });
  const deleteQueued = vi.fn(async (sessionId: string, itemId: string) => {
    const index = queueItems.findIndex((item) => item.itemId === itemId && item.sessionId === sessionId);
    if (index < 0) return { item: null };
    const [item] = queueItems.splice(index, 1);
    return { item: item ?? null };
  });
  const steerQueued = vi.fn(async (sessionId: string, itemId: string) => {
    const index = queueItems.findIndex((item) => item.itemId === itemId && item.sessionId === sessionId);
    if (index >= 0) queueItems[index] = { ...queueItems[index]!, status: 'running' };
    return { queueItemId: itemId, turnId: 'turn-1' };
  });
  let finishPrompt: (value: { stopReason: string }) => void = () => undefined;
  const prompt = vi.fn(() => new Promise((resolve) => (finishPrompt = resolve)));
  const agent = {
    extensionMethods: new Set<string>(options.runtimeQueue ? queueMethods : []),
    extensionNotifications: new Set<string>(options.notifications ?? []),
    supportsRuntimeQueue: options.runtimeQueue === true,
    listQueued,
    enqueueQueued,
    updateQueued,
    deleteQueued,
    steerQueued,
    loadSession,
    prompt,
  } as unknown as AlranAgent;
  const session = new SessionController('s1', '/work', {
    agent: () => agent,
    mcpServers: () => [],
    enterWhileRunning: () => 'steer',
    listener: {
      items: () => undefined,
      meta: () => undefined,
      snapshot: () => undefined,
      changes: () => undefined,
      attention: () => undefined,
      turn: () => undefined,
      authRequired: () => undefined,
      log: () => undefined,
    },
  });
  session.markReady();
  return {
    session,
    agent,
    prompt,
    loadSession,
    listQueued,
    enqueueQueued,
    updateQueued,
    deleteQueued,
    steerQueued,
    finish: () => finishPrompt({ stopReason: 'end_turn' }),
  };
}

describe('Runtime queue integration', () => {
  const item: RuntimeQueueItem = {
    itemId: 'queue-1',
    sessionId: 's1',
    status: 'queued',
    content: 'persist this prompt',
    attachments: [{}],
  };

  it('hydrates the durable queue on attach and clears it on an empty update', async () => {
    const context = createSession({ runtimeQueue: true, queueItems: [item] });
    await context.session.refreshExtensions();

    expect(context.listQueued).toHaveBeenCalledWith('s1');
    expect(context.session.meta.queue).toEqual([
      { id: 'runtime:queue-1', text: 'persist this prompt', attachmentCount: 1 },
    ]);

    context.session.handleRuntimeQueue([]);
    expect(context.session.meta.queue).toEqual([]);
  });

  it('uses the Runtime queue for text and keeps attachment prompts in the local queue', async () => {
    const context = createSession({ runtimeQueue: true });

    await context.session.enqueue({ text: 'queued in Runtime', attachments: [] });
    await context.session.enqueue({
      text: 'keep this attachment',
      attachments: [{ kind: 'text', id: 'a1', label: 'context', text: 'local context' }],
    });

    expect(context.enqueueQueued).toHaveBeenCalledWith('s1', 'queued in Runtime');
    expect(context.session.meta.queue).toEqual([
      { id: 'runtime:q1', text: 'queued in Runtime', attachmentCount: 0 },
      { id: expect.any(String), text: 'keep this attachment', attachmentCount: 1 },
    ]);
  });

  it('edits and deletes Runtime-owned entries through ACP', async () => {
    const context = createSession({ runtimeQueue: true, queueItems: [item] });
    await context.session.refreshExtensions();

    await context.session.editQueued('runtime:queue-1', 'updated prompt');
    expect(context.updateQueued).toHaveBeenCalledWith('s1', 'queue-1', 'updated prompt');
    expect(context.session.meta.queue[0]?.text).toBe('updated prompt');

    await context.session.deleteQueued('runtime:queue-1');
    expect(context.deleteQueued).toHaveBeenCalledWith('s1', 'queue-1');
    expect(context.session.meta.queue).toEqual([]);
  });

  it('clears only manageable pending Runtime queue entries', async () => {
    const context = createSession({
      runtimeQueue: true,
      queueItems: [
        item,
        { ...item, itemId: 'running', status: 'running' },
        { ...item, itemId: 'goal', source: 'thread-goal' },
      ],
    });
    await context.session.refreshExtensions();

    await context.session.clearQueue();

    expect(context.deleteQueued).toHaveBeenCalledTimes(1);
    expect(context.deleteQueued).toHaveBeenCalledWith('s1', 'queue-1');
    expect(context.session.meta.queue).toEqual([]);
  });

  it('sends a Runtime-owned queue entry immediately through ACP steer', async () => {
    const context = createSession({ runtimeQueue: true, queueItems: [item] });
    await context.session.refreshExtensions();

    await context.session.sendQueuedNow('runtime:queue-1');

    expect(context.steerQueued).toHaveBeenCalledWith('s1', 'queue-1');
    expect(context.session.meta.queue).toEqual([]);
    context.session.dispose();
  });

  it('keeps new text behind local attachment prompts to preserve queue ordering', async () => {
    const context = createSession({ runtimeQueue: true });
    await context.session.enqueue({
      text: 'first, with attachment',
      attachments: [{ kind: 'text', id: 'a1', label: 'context', text: 'local context' }],
    });
    await context.session.enqueue({ text: 'second, text only', attachments: [] });

    expect(context.enqueueQueued).not.toHaveBeenCalled();
    expect(context.session.meta.queue.map((entry) => entry.text)).toEqual([
      'first, with attachment',
      'second, text only',
    ]);
  });

  it('runs local attachment prompts after Runtime-owned queue turns finish', async () => {
    const context = createSession({
      runtimeQueue: true,
      queueItems: [{ ...item, status: 'running' }],
    });
    await context.session.refreshExtensions();
    await context.session.enqueue({
      text: 'local attachment prompt',
      attachments: [{ kind: 'text', id: 'a1', label: 'context', text: 'local context' }],
    });

    expect(context.prompt).not.toHaveBeenCalled();
    context.session.handleRuntimeQueue([{ ...item, status: 'completed' }]);
    expect(context.prompt).toHaveBeenCalledTimes(1);

    context.finish();
    context.session.dispose();
  });

  it('retains the local queue fallback when the CLI does not advertise Runtime queue methods', async () => {
    const context = createSession();
    await context.session.enqueue({ text: 'legacy queue', attachments: [] });

    expect(context.enqueueQueued).not.toHaveBeenCalled();
    expect(context.session.meta.queue).toMatchObject([{ text: 'legacy queue', attachmentCount: 0 }]);
    expect(context.session.meta.queue[0]?.id).not.toMatch(/^runtime:/u);
  });
});

const info = (at: number): acp.SessionUpdate => ({
  sessionUpdate: 'session_info_update',
  updatedAt: new Date(at).toISOString(),
});

describe('detached turn detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runTurn(context: ReturnType<typeof createSession>): Promise<number> {
    const turn = context.session.submit({ text: 'hi', attachments: [] });
    await vi.advanceTimersByTimeAsync(0);
    context.finish();
    await turn;
    return Date.now();
  }

  it('ignores a trailing event of the finished turn, even when delivered late', async () => {
    const context = createSession();
    const endedAt = await runTurn(context);
    await vi.advanceTimersByTimeAsync(5_000);
    context.session.handleUpdate(info(endedAt + 10));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(context.loadSession).not.toHaveBeenCalled();
    expect(context.session.meta.status).toBe('idle');
  });

  it('replays a turn that started later without a prompt', async () => {
    const context = createSession();
    const endedAt = await runTurn(context);
    await vi.advanceTimersByTimeAsync(10_000);
    context.session.handleUpdate(info(endedAt + 10_000));
    expect(context.session.meta.status).toBe('background');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(context.loadSession).toHaveBeenCalledTimes(1);
    context.session.handleUpdate({ sessionUpdate: 'usage_update', used: 1, size: 2 });
    expect(context.session.meta.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.loadSession).toHaveBeenCalledTimes(2);
  });
});

describe('output speed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const chunk = (text: string): acp.SessionUpdate => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });

  /** Two seconds of steady text: enough for the estimate to have something to say. */
  async function stream(context: ReturnType<typeof createSession>): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      context.session.handleUpdate(chunk('x'.repeat(40)));
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  /** The turn is returned inside an object: a bare promise returned from an async function would be awaited. */
  async function startTurn(context: ReturnType<typeof createSession>): Promise<{ turn: Promise<void> }> {
    const turn = context.session.submit({ text: 'hi', attachments: [] });
    await vi.advanceTimersByTimeAsync(0);
    return { turn };
  }

  it('shows the speed the CLI measured, and estimates nothing next to it', async () => {
    const context = createSession({ notifications: [OUTPUT_RATE_NOTIFICATION] });
    const { turn } = await startTurn(context);
    await stream(context);
    expect(context.session.meta.outputRate).toBeUndefined();

    context.session.handleOutputRate({ tokensPerSecond: 210, estimated: false });
    expect(context.session.meta.outputRate).toEqual({ tokensPerSecond: 210, estimated: false, live: true });
    await stream(context);
    // Text keeps streaming; the figure stays the CLI's, it is not replaced by an estimate.
    expect(context.session.meta.outputRate).toEqual({ tokensPerSecond: 210, estimated: false, live: true });

    context.finish();
    await turn;
    expect(context.session.meta.outputRate).toEqual({ tokensPerSecond: 210, estimated: false, live: false });
  });

  it('says nothing for a turn in which the CLI measured nothing, instead of guessing', async () => {
    const context = createSession({ notifications: [OUTPUT_RATE_NOTIFICATION] });
    const { turn } = await startTurn(context);
    await stream(context);
    context.finish();
    await turn;
    expect(context.session.meta.outputRate).toBeUndefined();
  });

  it('estimates from the text, marked as an estimate, for a CLI that does not send it', async () => {
    const context = createSession();
    const { turn } = await startTurn(context);
    await stream(context);
    expect(context.session.meta.outputRate).toMatchObject({ estimated: true, live: true });
    context.finish();
    await turn;
    expect(context.session.meta.outputRate).toMatchObject({ estimated: true, live: false });
  });

  it('ignores a figure that arrives when no turn is running', () => {
    const context = createSession({ notifications: [OUTPUT_RATE_NOTIFICATION] });
    context.session.handleOutputRate({ tokensPerSecond: 99, estimated: false });
    expect(context.session.meta.outputRate).toBeUndefined();
  });

  it('starts the next prompt without the last figure', async () => {
    const context = createSession({ notifications: [OUTPUT_RATE_NOTIFICATION] });
    const { turn: first } = await startTurn(context);
    context.session.handleOutputRate({ tokensPerSecond: 210, estimated: false });
    context.finish();
    await first;
    expect(context.session.meta.outputRate?.live).toBe(false);

    const { turn: second } = await startTurn(context);
    expect(context.session.meta.outputRate).toBeUndefined();
    context.finish();
    await second;
  });
});
