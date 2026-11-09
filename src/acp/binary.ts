import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export interface ResolvedCli {
  /** Program to spawn. */
  readonly command: string;
  /** Arguments that must precede every Alran subcommand (the script for `node x.js`). */
  readonly prefixArgs: readonly string[];
  /** Where the executable was found, for diagnostics. */
  readonly source: 'setting' | 'path' | 'login-shell' | 'well-known';
  readonly displayPath: string;
}

export interface ResolveCliOptions {
  readonly configuredPath?: string;
  readonly nodePath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly loginShellPath?: () => Promise<string | undefined>;
}

export class AlranCliNotFoundError extends Error {
  constructor(readonly searched: readonly string[]) {
    super('The Alran Code CLI (`alran`) was not found.');
    this.name = 'AlranCliNotFoundError';
  }
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** Finds the `alran` CLI: explicit setting, PATH, login-shell PATH, install locations. */
export async function resolveAlranCli(options: ResolveCliOptions): Promise<ResolvedCli> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const searched: string[] = [];
  const configured = options.configuredPath?.trim();
  if (configured) {
    const expanded = expandHome(configured, home);
    searched.push(expanded);
    if (!isAbsolute(expanded)) {
      const onPath = await findOnPath(expanded, options.env.PATH, platform);
      if (onPath) return toResolved(onPath, 'setting', options, platform);
    } else if (await isRunnable(expanded, platform)) {
      return toResolved(expanded, 'setting', options, platform);
    }
    throw new AlranCliNotFoundError(searched);
  }

  const fromPath = await findOnPath('alran', options.env.PATH, platform);
  if (fromPath) return toResolved(fromPath, 'path', options, platform);
  searched.push('PATH');

  const shellPath = await options.loginShellPath?.();
  if (shellPath) {
    const fromShell = await findOnPath('alran', shellPath, platform);
    if (fromShell) return toResolved(fromShell, 'login-shell', options, platform);
    searched.push('login shell PATH');
  }

  const executable = platform === 'win32' ? 'alran.cmd' : 'alran';
  const wellKnown = [
    // Default location of the official installer script.
    join(home, '.alran-code', 'bin', executable),
    ...(platform === 'win32' ? [join(home, '.alran-code', executable)] : []),
    join(home, '.alran', 'bin', executable),
    join(home, '.local', 'bin', executable),
    join(home, '.npm-global', 'bin', executable),
    join(home, '.volta', 'bin', executable),
    ...(platform === 'win32'
      ? [join(options.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'alran.cmd')]
      : ['/usr/local/bin/alran', '/opt/homebrew/bin/alran']),
  ];
  for (const candidate of wellKnown) {
    searched.push(candidate);
    if (await isRunnable(candidate, platform)) {
      return toResolved(candidate, 'well-known', options, platform);
    }
  }
  throw new AlranCliNotFoundError(searched);
}

function toResolved(
  path: string,
  source: ResolvedCli['source'],
  options: ResolveCliOptions,
  platform: NodeJS.Platform,
): ResolvedCli {
  if (SCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
    return {
      command: options.nodePath?.trim() || (platform === 'win32' ? 'node.exe' : 'node'),
      prefixArgs: [path],
      source,
      displayPath: path,
    };
  }
  return { command: path, prefixArgs: [], source, displayPath: path };
}

async function findOnPath(
  name: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (!pathValue) return undefined;
  const names =
    platform === 'win32' && !extname(name) ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name];
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (!directory) continue;
    for (const candidateName of names) {
      const candidate = join(directory, candidateName);
      if (await isRunnable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

async function isRunnable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (platform !== 'win32' && !SCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
      await access(path, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path;
}

/**
 * Editors launched from a desktop icon miss PATH entries set in shell profiles
 * (nvm, volta, npm prefixes), which is exactly where `alran` tends to live.
 */
export function readLoginShellPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  const shell = env.SHELL || '/bin/sh';
  const marker = '__ALRAN_PATH__';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5_000, encoding: 'utf8', env },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const match = new RegExp(`${marker}(.*)${marker}`, 'u').exec(stdout);
        resolve(match?.[1] || undefined);
      },
    );
  });
}

/** Spawn parameters that also work for npm's `.cmd` shims on Windows. */
export function spawnCommand(
  cli: ResolvedCli,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatim?: boolean } {
  const allArgs = [...cli.prefixArgs, ...args];
  if (platform === 'win32' && /\.(cmd|bat)$/iu.test(cli.command)) {
    const quoted = [cli.command, ...allArgs].map(quoteForCmd).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${quoted}"`],
      windowsVerbatim: true,
    };
  }
  return { command: cli.command, args: allArgs };
}

export function quoteForCmd(value: string): string {
  const escaped = value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1');
  return `"${escaped.replace(/([()%!^"<>&|])/gu, '^$1')}"`;
}
