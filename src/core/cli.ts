import { spawn } from 'node:child_process';

import { spawnCommand, type ResolvedCli } from '../acp/binary';

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliContext {
  readonly cli: ResolvedCli;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly globalArgs?: readonly string[];
}

export class AlranCliError extends Error {
  constructor(
    message: string,
    readonly result: CliResult,
  ) {
    super(message);
    this.name = 'AlranCliError';
  }
}

/** Runs one non-interactive `alran` subcommand and collects its output. */
export function runCli(
  context: CliContext,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<CliResult> {
  const spec = spawnCommand(context.cli, [...(context.globalArgs ?? []), ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: context.cwd,
      env: { ...context.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatim === true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 60_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runChecked(
  context: CliContext,
  args: readonly string[],
  options?: Parameters<typeof runCli>[2],
): Promise<string> {
  const result = await runCli(context, args, options);
  if (result.code !== 0) {
    throw new AlranCliError(
      (result.stderr || result.stdout).trim() || `alran ${args.join(' ')} failed.`,
      result,
    );
  }
  return result.stdout;
}

async function runJson<T>(
  context: CliContext,
  args: readonly string[],
  options?: Parameters<typeof runCli>[2],
): Promise<T> {
  return JSON.parse(await runChecked(context, [...args, '--json'], options)) as T;
}

export interface ProviderInfo {
  readonly providerId: string;
  readonly name: string;
  readonly kind: string;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly hasApiKey: boolean;
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
  readonly marketplace?: string;
  readonly source?: string;
  readonly version?: string;
  readonly enabled?: boolean;
  readonly installed?: boolean;
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
  const source = plugin.marketplace ?? plugin.source;
  return id.includes('@') || !source ? id : `${id}@${source}`;
}

export function pluginMentionLink(label: string, selector: string): string {
  return `[@${label}](plugin://${encodeURIComponent(selector)})`;
}
