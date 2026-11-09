import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AlranCliNotFoundError, quoteForCmd, resolveAlranCli, spawnCommand } from '../../src/acp/binary';

describe('resolveAlranCli', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'alran-binary-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const executable = (relative: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    return file;
  };

  const options = (extra: object = {}) => ({ env: { PATH: '' }, home: root, platform: 'linux' as const, ...extra });

  it('prefers the configured path and runs scripts with node', async () => {
    const script = executable('x/cli.js');
    const resolved = await resolveAlranCli(options({ configuredPath: script, nodePath: '/opt/node' }));
    expect(resolved).toMatchObject({ command: '/opt/node', prefixArgs: [script], source: 'setting' });
  });

  it('expands ~ in the configured path', async () => {
    const file = executable('tools/alran');
    expect((await resolveAlranCli(options({ configuredPath: '~/tools/alran' }))).command).toBe(file);
  });

  it('fails instead of falling back when the configured path is wrong', async () => {
    executable('.alran/bin/alran');
    await expect(resolveAlranCli(options({ configuredPath: path.join(root, 'nope') }))).rejects.toBeInstanceOf(
      AlranCliNotFoundError,
    );
  });

  it('searches PATH, then the login shell, then install locations', async () => {
    const onPath = executable('path-dir/alran');
    expect(
      await resolveAlranCli(options({ env: { PATH: path.dirname(onPath) } })),
    ).toMatchObject({ command: onPath, source: 'path' });

    const onShell = executable('shell-dir/alran');
    expect(
      await resolveAlranCli(options({ loginShellPath: () => Promise.resolve(path.dirname(onShell)) })),
    ).toMatchObject({ command: onShell, source: 'login-shell' });

    const wellKnown = executable('.local/bin/alran');
    expect(await resolveAlranCli(options())).toMatchObject({ command: wellKnown, source: 'well-known' });
  });

  it('reports what it searched', async () => {
    const error = await resolveAlranCli(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AlranCliNotFoundError);
    expect((error as AlranCliNotFoundError).searched).toContain('PATH');
  });
});

describe('spawnCommand', () => {
  it('passes arguments through on POSIX', () => {
    const spec = spawnCommand({ command: 'node', prefixArgs: ['cli.js'], source: 'path', displayPath: 'cli.js' }, ['acp'], 'linux');
    expect(spec).toEqual({ command: 'node', args: ['cli.js', 'acp'] });
  });

  it('routes npm shims through cmd.exe on Windows', () => {
    const spec = spawnCommand(
      { command: 'C:\\npm\\alran.cmd', prefixArgs: [], source: 'path', displayPath: 'alran.cmd' },
      ['acp'],
      'win32',
    );
    expect(spec.windowsVerbatim).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spec.args[3]).toContain('alran.cmd');
  });

  it('escapes cmd metacharacters', () => {
    expect(quoteForCmd('a&b')).toBe('"a^&b"');
  });
});
