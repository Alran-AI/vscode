import { describe, expect, it } from 'vitest';

import { collapseContext, diffText, patchToDiffLines, reverseApplyPatch } from '../../src/shared/patch';

const PATCH = '--- f\n+++ f\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO\n line three\n';

describe('reverseApplyPatch', () => {
  it('reconstructs the original text', () => {
    expect(reverseApplyPatch('line one\nline TWO\nline three\n', PATCH)).toBe('line one\nline two\nline three\n');
  });

  it('keeps CRLF line endings', () => {
    expect(reverseApplyPatch('line one\r\nline TWO\r\nline three\r\n', PATCH)).toBe(
      'line one\r\nline two\r\nline three\r\n',
    );
  });

  it('finds a hunk that moved because of later edits', () => {
    expect(reverseApplyPatch('new first\nline one\nline TWO\nline three\n', PATCH)).toBe(
      'new first\nline one\nline two\nline three\n',
    );
  });

  it('applies several hunks', () => {
    const patch = '@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -5,2 +5,2 @@\n e\n-f\n+F\n';
    expect(reverseApplyPatch('A\nb\nc\nd\ne\nF\n', patch)).toBe('a\nb\nc\nd\ne\nf\n');
  });

  it('refuses a patch that no longer matches', () => {
    expect(reverseApplyPatch('something else\n', PATCH)).toBeUndefined();
  });

  it('refuses an empty patch', () => {
    expect(reverseApplyPatch('x', 'no hunks')).toBeUndefined();
  });
});

describe('diff display', () => {
  it('parses patch lines without file headers', () => {
    expect(patchToDiffLines(PATCH).map((line) => line.type)).toEqual(['hunk', 'context', 'remove', 'add', 'context']);
  });

  it('computes a line diff', () => {
    expect(diffText('a\nb\nc', 'a\nX\nc')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'X' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('falls back when the changed region is huge', () => {
    const lines = diffText('a\nb', 'c\nd', 1);
    expect(lines.map((line) => line.type)).toEqual(['remove', 'remove', 'add', 'add']);
  });

  it('collapses long unchanged runs', () => {
    const before = Array.from({ length: 30 }, (_, index) => `l${String(index)}`).join('\n');
    const after = before.replace('l15', 'changed');
    const collapsed = collapseContext(diffText(before, after), 1);
    expect(collapsed.filter((line) => line.type === 'hunk')).toHaveLength(2);
    expect(collapsed.some((line) => line.type === 'add' && line.text === 'changed')).toBe(true);
  });
});
