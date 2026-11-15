/**
 * Small pure helpers for the chat UI: ranking and highlighting for the `/` and `@` menus, the
 * elapsed-time label, the +/- statistic of an edit and the folding of long runs of read-only tool
 * calls. No `vscode` and no Node imports (see `types.ts`).
 */

import { diffText, patchToDiffLines } from './patch';
import type { ToolItem, TranscriptItem } from './types';

/**
 * Orders items for a typed query: names that start with it first, then names with a word that starts
 * with it, then names that merely contain it. Items that do not match are left out. The order inside
 * each group is the order of `items`, so a list that was sorted already stays sorted.
 */
export function rankByQuery<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  const prefix: T[] = [];
  const word: T[] = [];
  const inside: T[] = [];
  for (const item of items) {
    const haystack = text(item).toLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) continue;
    if (index === 0) prefix.push(item);
    else if (/[\s\-_/.:]/u.test(haystack.charAt(index - 1))) word.push(item);
    else inside.push(item);
  }
  return [...prefix, ...word, ...inside];
}

/** Splits `text` around the first case-insensitive occurrence of `query`; `undefined` when absent. */
export function splitMatch(text: string, query: string): readonly [string, string, string] | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return undefined;
  return [text.slice(0, index), text.slice(index, index + needle.length), text.slice(index + needle.length)];
}

/** `7s`, `1m 05s`, `1h 02m`: how long something has been running. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

/** Added and removed lines of a unified patch; `undefined` when there is nothing to count. */
export function patchStat(patch: string | undefined): DiffStat | undefined {
  if (!patch) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of patchToDiffLines(patch)) {
    if (line.type === 'add') added += 1;
    else if (line.type === 'remove') removed += 1;
  }
  return added + removed > 0 ? { added, removed } : undefined;
}

/** The lines of a text; an empty text has none, and the line break at the end of a file is not a line. */
function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length;
}

/** Added and removed lines between two texts; `undefined` when no line differs. */
export function textStat(before: string, after: string): DiffStat | undefined {
  if (before === '' || after === '') {
    const lines = lineCount(before === '' ? after : before);
    if (lines === 0) return undefined;
    return before === '' ? { added: lines, removed: 0 } : { added: 0, removed: lines };
  }
  const trim = (text: string) => text.replace(/\n$/u, '');
  let added = 0;
  let removed = 0;
  for (const line of diffText(trim(before), trim(after))) {
    if (line.type === 'add') added += 1;
    else if (line.type === 'remove') removed += 1;
  }
  return added + removed > 0 ? { added, removed } : undefined;
}

/** Tools that only look at the project; a long run of them is noise next to an edit. */
export function isExploration(item: TranscriptItem): item is ToolItem {
  return item.kind === 'tool' && !item.parentId && (item.toolKind === 'read' || item.toolKind === 'search');
}

export interface ExplorationGroup {
  readonly kind: 'exploration';
  /** The id of the first tool, so the group keeps its identity while it grows. */
  readonly id: string;
  readonly tools: readonly ToolItem[];
}

export type TranscriptEntryModel = TranscriptItem | ExplorationGroup;

/**
 * Folds runs of at least `minimum` consecutive read-only tool calls into one group. Hidden thoughts
 * do not break a run. Everything else keeps its place and its order.
 */
export function groupExploration(
  items: readonly TranscriptItem[],
  options: { readonly skipThoughts: boolean; readonly minimum?: number },
): TranscriptEntryModel[] {
  const minimum = options.minimum ?? 3;
  const result: TranscriptEntryModel[] = [];
  let run: ToolItem[] = [];
  let pending: TranscriptItem[] = [];
  const flush = () => {
    if (run.length >= minimum) {
      const [first] = run;
      if (first) result.push({ kind: 'exploration', id: first.id, tools: run });
    } else {
      result.push(...run);
    }
    result.push(...pending);
    run = [];
    pending = [];
  };
  for (const item of items) {
    if (isExploration(item)) {
      // A thought that sat between two reads stays where it was, after the group.
      run.push(item);
    } else if (options.skipThoughts && item.kind === 'thought' && run.length > 0) {
      pending.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

/** A summary such as `Read 4 files, searched 2 times` for a group of read-only tool calls. */
export function describeExploration(tools: readonly ToolItem[]): string {
  const searches = tools.filter((tool) => tool.toolKind === 'search').length;
  const reads = tools.length - searches;
  const parts: string[] = [];
  if (reads > 0) parts.push(`read ${String(reads)} file${reads === 1 ? '' : 's'}`);
  if (searches > 0) parts.push(`searched ${String(searches)} time${searches === 1 ? '' : 's'}`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
