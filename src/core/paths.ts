import { realpath } from 'node:fs/promises';
import path from 'node:path';

export interface LocatedFile {
  /** Absolute path, symlinks resolved when the file exists. */
  readonly path: string;
  /** Whether it lies inside one of the allowed roots. */
  readonly inside: boolean;
}

async function resolveReal(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where a file the transcript names is, and whether that is inside the workspace. A path that is
 * relative, uses `..` or goes through a symlink is judged by where it ends up, not how it is written.
 */
export async function locateFile(
  filePath: string,
  cwd: string,
  roots: readonly string[],
): Promise<LocatedFile> {
  const target = await resolveReal(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
  const realRoots = await Promise.all(roots.filter(Boolean).map(resolveReal));
  return { path: target, inside: realRoots.some((root) => isWithin(root, target)) };
}
