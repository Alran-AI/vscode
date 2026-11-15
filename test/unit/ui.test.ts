import { describe, expect, it } from 'vitest';

import type { ThoughtItem, ToolItem, TranscriptItem } from '../../src/shared/types';
import {
  describeExploration,
  formatElapsed,
  groupExploration,
  patchStat,
  rankByQuery,
  splitMatch,
  textStat,
} from '../../src/shared/ui';

function tool(id: string, toolKind: string, extra: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    id,
    name: toolKind,
    title: toolKind,
    toolKind,
    status: 'completed',
    blocks: [],
    locations: [],
    timestamp: 0,
    ...extra,
  };
}

function thought(id: string): ThoughtItem {
  return { kind: 'thought', id, text: 'hm', streaming: false, timestamp: 0 };
}

describe('rankByQuery', () => {
  const names = ['review', 'preview', 'plan', 'add-dir', 'permission', 'plugin', 'store'];
  const rank = (query: string) => rankByQuery(names, query, (name) => name);

  it('keeps the order of the list for an empty query', () => {
    expect(rank('')).toEqual(names);
    expect(rank('  ')).toEqual(names);
  });

  it('puts names that start with the query before names that contain it', () => {
    expect(rank('pl')).toEqual(['plan', 'plugin']);
    // "review" starts with it; "preview" and "store" only contain it, in the order of the list.
    expect(rank('re')).toEqual(['review', 'preview', 'store']);
  });

  it('ranks the start of a word above the middle of one', () => {
    expect(rank('dir')).toEqual(['add-dir']);
    expect(rankByQuery(['xdir', 'a-dir', 'dirx'], 'dir', (name) => name)).toEqual(['dirx', 'a-dir', 'xdir']);
  });

  it('ignores case and drops what does not match', () => {
    expect(rank('PLAN')).toEqual(['plan']);
    expect(rank('zzz')).toEqual([]);
  });
});

describe('splitMatch', () => {
  it('splits around the first match, in the original case', () => {
    expect(splitMatch('/Review', 'rev')).toEqual(['/', 'Rev', 'iew']);
  });

  it('says nothing for an empty or missing query', () => {
    expect(splitMatch('review', '')).toBeUndefined();
    expect(splitMatch('review', 'x')).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  it('counts seconds, then minutes, then hours', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(7_400)).toBe('7s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_725_000)).toBe('1h 02m');
  });
});

describe('patchStat', () => {
  it('counts added and removed lines and ignores the file header', () => {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,4 @@', ' keep', '-old', '+new', '+extra', ' end'].join('\n');
    expect(patchStat(patch)).toEqual({ added: 2, removed: 1 });
  });

  it('is undefined without a patch or without a change', () => {
    expect(patchStat(undefined)).toBeUndefined();
    expect(patchStat('')).toBeUndefined();
    expect(patchStat('@@ -1 +1 @@\n same')).toBeUndefined();
  });
});

describe('groupExploration', () => {
  const group = (items: readonly TranscriptItem[], skipThoughts = false) => groupExploration(items, { skipThoughts });
  const shape = (entries: ReturnType<typeof group>) =>
    entries.map((entry) => (entry.kind === 'exploration' ? `[${entry.tools.map((item) => item.id).join(',')}]` : entry.id));

  it('folds three or more consecutive reads and searches', () => {
    const items = [tool('a', 'read'), tool('b', 'search'), tool('c', 'read'), tool('d', 'edit')];
    expect(shape(group(items))).toEqual(['[a,b,c]', 'd']);
  });

  it('leaves a short run alone', () => {
    const items = [tool('a', 'read'), tool('b', 'read'), tool('c', 'edit')];
    expect(shape(group(items))).toEqual(['a', 'b', 'c']);
  });

  it('is broken by anything that is not a read-only tool', () => {
    const items = [tool('a', 'read'), tool('b', 'read'), tool('x', 'execute'), tool('c', 'read'), tool('d', 'read')];
    expect(shape(group(items))).toEqual(['a', 'b', 'x', 'c', 'd']);
  });

  it('keeps a group that is still running together with its finished calls', () => {
    const items = [tool('a', 'read'), tool('b', 'read'), tool('c', 'read', { status: 'in_progress' })];
    expect(shape(group(items))).toEqual(['[a,b,c]']);
  });

  it('does not take child calls of a program run into a group', () => {
    const items = [tool('a', 'read'), tool('b', 'read', { parentId: 'p' }), tool('c', 'read'), tool('d', 'read')];
    expect(shape(group(items))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lets a thought that is not shown sit inside a run', () => {
    const items = [tool('a', 'read'), thought('t'), tool('b', 'read'), tool('c', 'read')];
    expect(shape(group(items, true))).toEqual(['[a,b,c]', 't']);
    expect(shape(group(items, false))).toEqual(['a', 't', 'b', 'c']);
  });

  it('keeps the id of the first call when the group grows', () => {
    const three = group([tool('a', 'read'), tool('b', 'read'), tool('c', 'read')]);
    const four = group([tool('a', 'read'), tool('b', 'read'), tool('c', 'read'), tool('d', 'read')]);
    expect(three[0]?.id).toBe(four[0]?.id);
  });
});

describe('describeExploration', () => {
  it('says how many files were read and how often the code was searched', () => {
    expect(describeExploration([tool('a', 'read'), tool('b', 'read'), tool('c', 'search')])).toBe(
      'Read 2 files, searched 1 time',
    );
    expect(describeExploration([tool('a', 'search'), tool('b', 'search')])).toBe('Searched 2 times');
    expect(describeExploration([tool('a', 'read')])).toBe('Read 1 file');
  });
});

describe('textStat', () => {
  it('counts the lines that differ', () => {
    expect(textStat('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
  });

  it('counts a whole new file and a whole removed file', () => {
    expect(textStat('', 'one\ntwo')).toEqual({ added: 2, removed: 0 });
    expect(textStat('one\ntwo', '')).toEqual({ added: 0, removed: 2 });
  });

  it('is undefined for the same text', () => {
    expect(textStat('same\n', 'same\n')).toBeUndefined();
  });
});
