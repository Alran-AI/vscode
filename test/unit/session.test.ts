import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlranAgent } from '../../src/acp/agent';
import { SessionController } from '../../src/core/session';

function createSession() {
  const loadSession = vi.fn().mockResolvedValue({});
  let finishPrompt: (value: { stopReason: string }) => void = () => undefined;
  const agent = {
    extensionMethods: new Set<string>(),
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
