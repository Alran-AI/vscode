import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChangeTracker, isInterestingPath, proposedEdit } from '../../src/core/changes';
import type { ToolItem } from '../../src/shared/types';

describe('ChangeTracker', () => {
  let root: string;
  let file: string;
  let tracker: ChangeTracker;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'alran-changes-'));
    file = path.join(root, 'a.txt');
    tracker = new ChangeTracker();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const tool = (extra: Partial<ToolItem>): ToolItem => ({
    kind: 'tool',
    id: 't1',
    name: 'edit',
    title: 'edit',
    toolKind: 'edit',
    status: 'in_progress',
    blocks: [],
    locations: [file],
    timestamp: 0,
    ...extra,
  });

  it('captures the file before the edit and reverts it', async () => {
    writeFileSync(file, 'before\n');
    await tracker.observeTool(tool({}));
    writeFileSync(file, 'after\n');
    await tracker.observeTool(tool({ status: 'completed' }));
    expect(tracker.get(file)?.before).toBe('before\n');
    await tracker.revert(file);
    expect(readFileSync(file, 'utf8')).toBe('before\n');
    expect(tracker.list()).toEqual([]);
  });

  it('repairs a snapshot taken after the write from the patch', async () => {
    writeFileSync(file, 'line TWO\n');
    await tracker.observeTool(
      tool({ status: 'completed', patch: '--- a\n+++ a\n@@ -1 +1 @@\n-line two\n+line TWO\n' }),
    );
    expect(tracker.get(file)?.before).toBe('line two\n');
  });

  it('deletes a created file on revert', async () => {
    await tracker.observeTool(tool({}));
    writeFileSync(file, 'new');
    await tracker.observeTool(tool({ status: 'completed', created: true }));
    expect(tracker.get(file)?.before).toBeNull();
    await tracker.revert(file);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the earliest baseline across several edits', async () => {
    writeFileSync(file, 'one');
    await tracker.observeTool(tool({ id: 'a' }));
    writeFileSync(file, 'two');
    await tracker.observeTool(tool({ id: 'b' }));
    writeFileSync(file, 'three');
    await tracker.observeTool(tool({ id: 'b', status: 'completed' }));
    expect(tracker.get(file)?.before).toBe('one');
  });

  it('ignores tools that do not modify files', async () => {
    await tracker.observeTool(tool({ toolKind: 'read' }));
    expect(tracker.list()).toEqual([]);
  });

  it('ignores a failed call that never produced a change', async () => {
    writeFileSync(file, 'same');
    await tracker.observeTool(tool({ status: 'failed' }));
    expect(tracker.list()).toEqual([]);
  });

  it('drops entries whose file ended up unchanged', async () => {
    writeFileSync(file, 'same');
    await tracker.observeTool(tool({}));
    expect(await tracker.pruneUnchanged()).toBe(true);
    expect(tracker.list()).toEqual([]);
  });

  it('refuses to revert an externally observed file without a baseline', async () => {
    writeFileSync(file, 'x');
    tracker.observeExternalChange(file);
    await expect(tracker.revert(file)).rejects.toThrow(/not captured/u);
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('computes a proposed edit for the permission preview', async () => {
    writeFileSync(file, 'a b a');
    expect(await proposedEdit({ file_path: file, old_string: 'a', new_string: '$&X' })).toMatchObject({
      before: 'a b a',
      after: '$&X b a',
    });
    expect(await proposedEdit({ path: file, content: 'new' })).toMatchObject({ after: 'new' });
    expect(await proposedEdit({ command: 'ls' })).toBeUndefined();
  });

  it('filters generated directories', () => {
    expect(isInterestingPath('/w/src/a.ts')).toBe(true);
    expect(isInterestingPath('/w/node_modules/a.js')).toBe(false);
    expect(isInterestingPath('C:\\w\\.git\\HEAD')).toBe(false);
  });
});
