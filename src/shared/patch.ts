/**
 * Minimal unified-diff support: the agent reports edits as unified patches, and
 * the extension needs the pre-edit text to show diffs and revert a file.
 */

export interface PatchHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export function parsePatch(patch: string): PatchHunk[] {
  const hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | undefined;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/**
 * Reconstructs the file as it was before `patch`, or returns undefined when the
 * current text no longer matches the patch (the file changed again since).
 */
export function reverseApplyPatch(current: string, patch: string): string | undefined {
  const hunks = parsePatch(patch);
  if (hunks.length === 0) return undefined;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/u);
  for (const hunk of [...hunks].reverse()) {
    const newLines = hunk.lines.flatMap((line) => (line.startsWith('-') ? [] : [line.slice(1)]));
    const oldLines = hunk.lines.flatMap((line) => (line.startsWith('+') ? [] : [line.slice(1)]));
    const start = locate(lines, newLines, Math.max(0, hunk.newStart - 1));
    if (start === undefined) return undefined;
    lines.splice(start, newLines.length, ...oldLines);
  }
  return lines.join(eol);
}

function locate(lines: readonly string[], needle: readonly string[], hint: number): number | undefined {
  if (needle.length === 0) return Math.min(hint, lines.length);
  const matches = (at: number) =>
    at >= 0 &&
    at + needle.length <= lines.length &&
    needle.every((line, offset) => lines[at + offset] === line);
  if (matches(hint)) return hint;
  // Tolerate offsets from other hunks in the same file, nearest position first.
  for (let distance = 1; distance <= lines.length; distance += 1) {
    if (matches(hint - distance)) return hint - distance;
    if (matches(hint + distance)) return hint + distance;
  }
  return undefined;
}

export type DiffLine =
  | { readonly type: 'context' | 'add' | 'remove'; readonly text: string }
  | { readonly type: 'hunk'; readonly text: string };

/** Display lines of a unified patch, without the file header. */
export function patchToDiffLines(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@')) result.push({ type: 'hunk', text: line });
    else if (line.startsWith('+')) result.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) result.push({ type: 'remove', text: line.slice(1) });
    else if (line.startsWith(' ')) result.push({ type: 'context', text: line.slice(1) });
  }
  return result;
}

/**
 * Line diff of two short texts for previews (longest common subsequence with
 * trimmed common prefix and suffix). Falls back to remove-all/add-all when the
 * middle section is too large to compare cheaply.
 */
export function diffText(oldText: string, newText: string, maxCells = 4_000_000): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const head = a.slice(0, prefix).map((text): DiffLine => ({ type: 'context', text }));
  const tail = a.slice(a.length - suffix).map((text): DiffLine => ({ type: 'context', text }));
  if (midA.length * midB.length > maxCells) {
    return [
      ...head,
      ...midA.map((text): DiffLine => ({ type: 'remove', text })),
      ...midB.map((text): DiffLine => ({ type: 'add', text })),
      ...tail,
    ];
  }
  const width = midB.length + 1;
  const table = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      middle.push({ type: 'context', text: midA[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      middle.push({ type: 'remove', text: midA[i] ?? '' });
      i += 1;
    } else {
      middle.push({ type: 'add', text: midB[j] ?? '' });
      j += 1;
    }
  }
  for (; i < midA.length; i += 1) middle.push({ type: 'remove', text: midA[i] ?? '' });
  for (; j < midB.length; j += 1) middle.push({ type: 'add', text: midB[j] ?? '' });
  return [...head, ...middle, ...tail];
}

/** Keeps changed lines plus `context` lines around them, joining the rest as a gap. */
export function collapseContext(lines: readonly DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'context') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) {
      keep[k] = true;
    }
  });
  const result: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) result.push({ type: 'hunk', text: `⋯ ${String(skipped)} unchanged lines` });
      skipped = 0;
      result.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0 && result.length > 0) {
    result.push({ type: 'hunk', text: `⋯ ${String(skipped)} unchanged lines` });
  }
  return result;
}
