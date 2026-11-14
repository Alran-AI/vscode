import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli, type CliContext } from '../../src/core/cli';

const script = path.resolve(__dirname, '..', 'fixtures', 'stubborn-cli.cjs');
const context = (mode: string): CliContext => ({
  cli: { command: process.execPath, prefixArgs: [script], source: 'setting', displayPath: script },
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? '' },
  globalArgs: [mode],
});

describe('runCli timeout', () => {
  it('returns normally when the command finishes', async () => {
    const result = await runCli(context('ok'), [], { timeoutMs: 5_000 });
    expect(result).toMatchObject({ code: 0, stdout: 'ok\n' });
    expect(result.timedOut).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('kills a command that ignores SIGTERM', async () => {
    const started = Date.now();
    const result = await runCli(context('ignore-sigterm'), [], { timeoutMs: 150, killGraceMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.skipIf(process.platform === 'win32')('settles even when a descendant keeps the pipes open', async () => {
    const started = Date.now();
    const result = await runCli(context('leave-pipes'), [], { timeoutMs: 300, killGraceMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('started');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
