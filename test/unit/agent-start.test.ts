import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AlranAgent, type AgentHandlers } from '../../src/acp/agent';

const script = path.resolve(__dirname, '..', 'fixtures', 'stubborn-cli.cjs');
const handlers: AgentHandlers = {
  onUpdate: () => undefined,
  onPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  onElicitation: () => Promise.resolve({ action: 'cancel' }),
  onQueueUpdate: () => undefined,
  onGoalUpdate: () => undefined,
  onDelegationUpdate: () => undefined,
  onOutputRate: () => undefined,
  onCurrentSession: () => undefined,
  onLog: () => undefined,
  onExit: () => undefined,
};

describe('starting the agent', () => {
  it.skipIf(process.platform === 'win32')(
    'gives up on a process that starts and never answers `initialize`, and stops it',
    async () => {
      const agent = new AlranAgent(
        {
          cli: { command: process.execPath, prefixArgs: [script], source: 'setting', displayPath: script },
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? '' },
          globalArgs: ['silent'],
          initializeTimeoutMs: 400,
        },
        handlers,
      );
      const started = Date.now();
      await expect(agent.start()).rejects.toThrow(/did not answer within/u);
      expect(Date.now() - started).toBeLessThan(10_000);
      // The silent process was stopped, not abandoned.
      expect(agent.running).toBe(false);
    },
  );
});
