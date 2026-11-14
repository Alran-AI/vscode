import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { locateFile } from '../../src/core/paths';

describe('locateFile', () => {
  let base: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'alran-paths-'));
    workspace = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(workspace, 'src', 'a.ts'), '');
    writeFileSync(path.join(outside, 'secret'), '');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('accepts files inside the workspace, relative or absolute', async () => {
    expect((await locateFile('src/a.ts', workspace, [workspace])).inside).toBe(true);
    expect((await locateFile(path.join(workspace, 'src', 'a.ts'), workspace, [workspace])).inside).toBe(true);
    expect((await locateFile('src/new-file.ts', workspace, [workspace])).inside).toBe(true);
  });

  it('flags absolute paths and `..` that leave it', async () => {
    expect((await locateFile(path.join(outside, 'secret'), workspace, [workspace])).inside).toBe(false);
    expect((await locateFile('../outside/secret', workspace, [workspace])).inside).toBe(false);
    expect((await locateFile('src/../../outside/secret', workspace, [workspace])).inside).toBe(false);
  });

  it('flags a symlink that points out of the workspace', async () => {
    symlinkSync(outside, path.join(workspace, 'link'));
    const located = await locateFile('link/secret', workspace, [workspace]);
    expect(located.inside).toBe(false);
    expect(path.basename(located.path)).toBe('secret');
    expect(path.basename(path.dirname(located.path))).toBe('outside');
  });

  it('does not treat a sibling that shares a prefix as inside', async () => {
    mkdirSync(`${workspace}-evil`);
    expect((await locateFile(`${workspace}-evil/x`, workspace, [workspace])).inside).toBe(false);
  });

  it('allows any of several roots', async () => {
    expect((await locateFile(path.join(outside, 'secret'), workspace, [workspace, outside])).inside).toBe(true);
  });
});
