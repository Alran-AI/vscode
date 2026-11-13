import { spawn } from 'node:child_process';

import { spawnCommand, type ResolvedCli } from '../acp/binary';

export interface CliContext {
  readonly cli: ResolvedCli;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly globalArgs?: readonly string[];
}

/** What a failed `alran` subcommand means, from the exit codes of the account commands. */
export type CliFailureKind = 'auth' | 'rate-limit' | 'offline' | 'credits' | 'timeout' | 'error';

const EXIT_KINDS: Readonly<Record<number, CliFailureKind>> = {
  2: 'auth',
  3: 'rate-limit',
  4: 'offline',
  5: 'credits',
};

export class AlranCliError extends Error {
  readonly kind: CliFailureKind;

  constructor(
    message: string,
    readonly result: CliResult,
  ) {
    super(message);
    this.name = 'AlranCliError';
    this.kind = result.timedOut ? 'timeout' : (EXIT_KINDS[result.code ?? -1] ?? 'error');
  }
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

/**
 * The person-facing part of a failed command's output: the CLI's own message,
 * without the weekly update hint, Node warnings, or stack traces.
 */
export function cliFailureMessage(result: CliResult, args: readonly string[]): string {
  if (result.timedOut) return `\`alran ${args.join(' ')}\` did not finish in time.`;
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^\(node:\d+\)/u.test(line) &&
        !/^\(Use `node --trace/u.test(line) &&
        !/^at\s/u.test(line) &&
        !/update available|alran update|npm install -g alran/iu.test(line),
    );
  const message = lines.slice(0, 4).join(' ');
  return message || `\`alran ${args.join(' ')}\` failed (exit code ${String(result.code)}).`;
}

/**
 * Concurrent first runs on a fresh data directory race on the runtime's
 * database migration ("migration_failed … duplicate column"); a moment later
 * the same command succeeds.
 */
export function isTransientStorageFailure(text: string): boolean {
  return /migration_failed|duplicate column name|SQLITE_BUSY|database is locked/iu.test(text);
}

/** Runs one non-interactive `alran` subcommand, retrying a transient storage race. */
export async function runCli(
  context: CliContext,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly input?: string;
  } = {},
): Promise<CliResult> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await runCliOnce(context, args, options);
    if (result.code === 0 || attempt >= 4 || !isTransientStorageFailure(result.stderr)) return result;
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
}

function runCliOnce(
  context: CliContext,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    /** Written to stdin, which is otherwise closed. */
    readonly input?: string;
  } = {},
): Promise<CliResult> {
  const spec = spawnCommand(context.cli, [...(context.globalArgs ?? []), ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: context.cwd,
      // The account commands print their weekly update hint on stderr; the
      // extension reads the version from the agent instead.
      env: { ...context.env, ALRAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1', ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatim === true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? 60_000);
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

export async function runChecked(
  context: CliContext,
  args: readonly string[],
  options?: Parameters<typeof runCli>[2],
): Promise<string> {
  const result = await runCli(context, args, options);
  if (result.code !== 0) throw new AlranCliError(cliFailureMessage(result, args), result);
  return result.stdout;
}

export async function runJson<T>(
  context: CliContext,
  args: readonly string[],
  options?: Parameters<typeof runCli>[2],
): Promise<T> {
  const stdout = await runChecked(context, [...args, '--json'], options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new AlranCliError(
      `\`alran ${args.join(' ')} --json\` printed no JSON. The installed CLI may be too old for this extension; run "Alran: Update Alran CLI".`,
      { code: 0, stdout, stderr: '' },
    );
  }
}

export interface ProviderInfo {
  readonly providerId: string;
  readonly name: string;
  readonly kind: string;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly hasApiKey: boolean;
  readonly maskedApiKey?: string;
  readonly models: readonly (string | { readonly id?: string; readonly modelId?: string })[];
}

export interface ProviderList {
  readonly alranModelSource?: string;
  readonly providers: readonly ProviderInfo[];
}

export interface AddProviderInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiFormat: string;
  readonly models: readonly string[];
  readonly apiKey?: string;
  readonly use?: boolean;
}

/** Name of the variable that hands API keys to the CLI without using argv or disk. */
const API_KEY_ENV = 'ALRAN_VSCODE_API_KEY';

export const providers = {
  list: (context: CliContext) => runJson<ProviderList>(context, ['provider', 'list']),

  add(context: CliContext, input: AddProviderInput): Promise<string> {
    const args = [
      'provider',
      'add',
      '--name',
      input.name,
      '--base-url',
      input.baseUrl,
      '--api-format',
      input.apiFormat,
      ...input.models.flatMap((model) => ['--model', model]),
      ...(input.apiKey ? ['--api-key-env', API_KEY_ENV] : []),
      ...(input.use ? ['--use'] : []),
    ];
    return runChecked(
      context,
      args,
      input.apiKey ? { env: { [API_KEY_ENV]: input.apiKey }, timeoutMs: 120_000 } : { timeoutMs: 120_000 },
    );
  },

  remove: (context: CliContext, providerId: string) =>
    runChecked(context, ['provider', 'remove', providerId, '--yes']),

  test: (context: CliContext, providerId: string) =>
    runCli(context, ['provider', 'test', providerId, '--json'], { timeoutMs: 120_000 }),

  use: (context: CliContext, source: 'token-plan' | 'api-key') =>
    runChecked(context, ['provider', 'use', source]),

  setAlranKey: (context: CliContext, apiKey: string) =>
    runChecked(context, ['provider', 'set-alran-key', '--api-key-env', API_KEY_ENV], {
      env: { [API_KEY_ENV]: apiKey },
    }),
};

export interface PluginInfo {
  readonly id?: string;
  readonly pluginId?: string;
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  /** `plugin list --json` names the store it came from `marketplaceName`. */
  readonly marketplaceName?: string;
  readonly marketplace?: string;
  readonly source?: string;
  readonly version?: string;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly author?: string;
  /** Counts of what the Plugin contains, as `plugin list --json` reports them. */
  readonly capabilities?: { readonly skillCount?: number; readonly mcpServerCount?: number; readonly appCount?: number };
}

export interface PluginList {
  readonly installed: readonly PluginInfo[];
  readonly available: readonly PluginInfo[];
}

export interface MarketplaceInfo {
  readonly name: string;
  readonly kind: string;
  readonly path?: string;
}

export type PluginAction = 'add' | 'remove' | 'enable' | 'disable';

export const plugins = {
  /** Installed plugins, plus the catalog when reachable; offline falls back to installed. */
  async list(context: CliContext): Promise<PluginList & { readonly catalogError?: string }> {
    try {
      return await runJson<PluginList>(context, ['plugin', 'list', '--available']);
    } catch (error) {
      const installed = await runJson<PluginList>(context, ['plugin', 'list']);
      return {
        ...installed,
        catalogError: error instanceof Error ? error.message : String(error),
      };
    }
  },

  action: (context: CliContext, action: PluginAction, selector: string) =>
    runChecked(context, ['plugin', action, selector], { timeoutMs: 180_000 }),

  marketplaces: (context: CliContext) =>
    runJson<MarketplaceInfo[]>(context, ['plugin', 'marketplace', 'list']),

  upgradeMarketplaces: (context: CliContext) =>
    runChecked(context, ['plugin', 'marketplace', 'upgrade'], { timeoutMs: 180_000 }),
};

export const telemetry = {
  status: (context: CliContext) => runChecked(context, ['telemetry', 'status']),
  preview: (context: CliContext) => runChecked(context, ['telemetry', 'preview']),
};

export function pluginSelector(plugin: PluginInfo): string {
  const id = plugin.id ?? plugin.pluginId ?? plugin.name;
  const source = plugin.marketplaceName ?? plugin.marketplace ?? plugin.source;
  return id.includes('@') || !source ? id : `${id}@${source}`;
}

export function pluginMentionLink(label: string, selector: string): string {
  return `[@${label}](plugin://${encodeURIComponent(selector)})`;
}
