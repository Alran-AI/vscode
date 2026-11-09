import { execFile } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { reverseApplyPatch } from '../shared/patch';
import type { ToolItem } from '../shared/types';

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export type ChangeOrigin = 'tool' | 'observed';

export interface FileChange {
  readonly path: string;
  /** Text before the session touched it; `null` when the session created the file. */
  before: string | null | undefined;
  readonly origin: ChangeOrigin;
  readonly toolIds: Set<string>;
}

/**
 * Remembers what a session changed on disk so the editor can diff and revert
 * it. Alran writes files itself, so the pre-edit text is captured when a tool
 * call first names a path, and repaired from the tool's own patch when the
 * write won that race.
 */
export class ChangeTracker {
  private readonly changes = new Map<string, FileChange>();
  private readonly captures = new Map<string, Promise<void>>();

  list(): readonly FileChange[] {
    return [...this.changes.values()];
  }

  get(path: string): FileChange | undefined {
    return this.changes.get(resolve(path));
  }

  clear(): void {
    this.changes.clear();
  }

  /** Call for every tool update; idempotent and safe to call repeatedly. */
  async observeTool(tool: ToolItem): Promise<boolean> {
    if (tool.toolKind !== 'edit' && tool.toolKind !== 'delete' && tool.toolKind !== 'move') {
      return false;
    }
    let changed = false;
    for (const location of tool.locations) {
      const path = resolve(location);
      if (tool.status === 'failed' && !this.changes.has(path)) continue;
      if (!this.changes.has(path)) {
        this.changes.set(path, { path, before: undefined, origin: 'tool', toolIds: new Set() });
        this.captures.set(path, this.capture(path));
        changed = true;
      }
      const change = this.changes.get(path);
      if (!change) continue;
      change.toolIds.add(tool.id);
      await this.captures.get(path);
      if (tool.status === 'completed') {
        changed = (await this.reconcile(change, tool)) || changed;
      }
    }
    return changed;
  }

  /** Records a file a command changed outside the edit tools (formatters, `sed`). */
  observeExternalChange(path: string): boolean {
    const absolute = resolve(path);
    if (this.changes.has(absolute)) return false;
    this.changes.set(absolute, {
      path: absolute,
      before: undefined,
      origin: 'observed',
      toolIds: new Set(),
    });
    return true;
  }

  /** Removes a failed edit's entry when it left the file untouched. */
  async pruneUnchanged(): Promise<boolean> {
    let changed = false;
    for (const change of this.changes.values()) {
      if (change.before === undefined) continue;
      const current = await readText(change.path);
      if (current === change.before) {
        this.changes.delete(change.path);
        changed = true;
      }
    }
    return changed;
  }

  /** Pre-edit text, falling back to the last Git commit for observed changes. */
  async baseline(path: string): Promise<string | null | undefined> {
    const change = this.get(path);
    if (!change) return undefined;
    if (change.before !== undefined) return change.before;
    return gitShowHead(change.path);
  }

  async revert(path: string): Promise<void> {
    const change = this.get(path);
    if (!change) throw new Error(`No recorded change for ${path}.`);
    if (change.before === undefined) {
      throw new Error('The original content of this file was not captured, so it cannot be reverted.');
    }
    if (change.before === null) {
      await rm(change.path, { force: true });
    } else {
      await mkdir(dirname(change.path), { recursive: true });
      await writeFile(change.path, change.before, 'utf8');
    }
    this.changes.delete(change.path);
  }

  private async capture(path: string): Promise<void> {
    const change = this.changes.get(path);
    if (!change) return;
    change.before = await readText(path);
  }

  private async reconcile(change: FileChange, tool: ToolItem): Promise<boolean> {
    if (tool.created && change.toolIds.size === 1) {
      const changed = change.before !== null;
      change.before = null;
      return changed;
    }
    if (!tool.patch) return false;
    const current = await readText(change.path);
    if (current === undefined || current === null) return false;
    // A snapshot equal to the edited text means the write beat the snapshot.
    if (change.before === undefined || change.before === null || change.before === current) {
      const reconstructed = reverseApplyPatch(current, tool.patch);
      if (reconstructed !== undefined && reconstructed !== change.before) {
        change.before = reconstructed;
        return true;
      }
    }
    return false;
  }
}

/** `null` when the file does not exist; `undefined` when it is too large or binary. */
async function readText(path: string): Promise<string | null | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return undefined;
    const buffer = await readFile(path);
    return buffer.includes(0) ? undefined : buffer.toString('utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_SNAPSHOT_BYTES * 2, timeout: 10_000 },
      (error, stdout) => done(error ? undefined : stdout),
    );
  });
}

async function gitShowHead(path: string): Promise<string | null | undefined> {
  const directory = dirname(path);
  const root = (await git(directory, ['rev-parse', '--show-toplevel']))?.trim();
  if (!root) return undefined;
  const relativePath = relative(root, path).split('\\').join('/');
  const content = await git(root, ['show', `HEAD:${relativePath}`]);
  return content ?? null;
}

const UNINTERESTING_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.alran',
  '.DS_Store',
  '__pycache__',
  '.venv',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
]);

export function isInterestingPath(path: string): boolean {
  return !path.split(/[\\/]/u).some((segment) => UNINTERESTING_SEGMENTS.has(segment));
}

/** The file the permission card previews: its current and proposed text. */
export async function proposedEdit(
  input: unknown,
): Promise<{ readonly path: string; readonly before: string; readonly after: string } | undefined> {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const path = [record.file_path, record.path, record.filePath].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (!path) return undefined;
  const existing = await readText(path);
  const before = typeof existing === 'string' ? existing : '';
  if (typeof record.content === 'string') return { path, before, after: record.content };
  if (typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    if (!before.includes(record.old_string)) return { path, before, after: before };
    return {
      path,
      before,
      after:
        record.replace_all === true
          ? before.split(record.old_string).join(record.new_string)
          : before.replace(record.old_string, () => record.new_string as string),
    };
  }
  return undefined;
}
