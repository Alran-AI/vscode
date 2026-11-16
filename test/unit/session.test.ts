import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OUTPUT_RATE_NOTIFICATION, type AlranAgent } from '../../src/acp/agent';
import { SessionController } from '../../src/core/session';

function createSession(options: { notifications?: readonly string[] } = {}) {
  const loadSession = vi.fn().mockResolvedValue({});
  let finishPrompt: (value: { stopReason: string }) => void = () => undefined;
  const agent = {
    extensionMethods: new Set<string>(),
    extensionNotifications: new Set<string>(options.notifications ?? []),
    loadSession,
    prompt: vi.fn(() => new Promise((resolve) => (finishPrompt = resolve))),
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
  return { session, loadSession, finish: () => finishPrompt({ stopReason: 'end_turn' }) };
}

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
