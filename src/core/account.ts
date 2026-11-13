import { spawn } from 'node:child_process';

import { spawnCommand } from '../acp/binary';
import { AlranCliError, cliFailureMessage, runCli, type CliContext, type CliResult, type ProviderList } from './cli';

/**
 * The Ottili account as the CLI's account commands report it (`alran auth`,
 * `alran config`, `alran models`, `alran usage`, `alran billing`). Free of
 * `vscode` imports so it is tested against the real CLI in plain Node.
 */

export interface AccountStatus {
  readonly signedIn: boolean;
  readonly name?: string;
  readonly subjectId?: string;
  readonly companyId?: string;
  readonly projectId?: string | null;
  readonly environment?: string;
  readonly platform?: string;
  readonly gateway?: string;
  readonly sessionExpiresAt?: string | null;
  readonly defaultModel?: string;
}

export interface Company {
  readonly company_id: string;
  readonly slug?: string;
  readonly status?: string;
  readonly roles?: readonly string[];
}

export interface Project {
  readonly project_id: string;
  readonly name?: string;
  readonly status?: string;
  readonly access?: { readonly role?: string };
}

export type ModelAvailability =
  | 'available'
  | 'requires purchased credit'
  | 'no credit left'
  | 'not offered right now'
  | 'sign in to check'
  | string;

export interface OttiliModel {
  /** `provider/model`, the CLI's default-model key. */
  readonly key: string;
  /** Gateway id, for example `ottili/werk-1.1`. */
  readonly id: string;
  /** Short name accepted by `alran config model`. */
  readonly short: string;
  readonly name: string;
  /** Micro-USD per million input tokens. */
  readonly input: number;
  /** Micro-USD per million output tokens. */
  readonly output: number;
  readonly feeBps: number;
  readonly credit: string;
  readonly description: string;
  readonly status: ModelAvailability;
  readonly default: boolean;
}

export interface UsageRow {
  readonly model: string;
  readonly requests: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cost_microcents: number;
  readonly service_fee_microcents?: number;
}

export interface Credits {
  readonly currency?: string;
  readonly balance_microcents?: number;
  readonly available_microcents?: number;
  readonly reserved_microcents?: number;
  readonly free_credit?: { readonly granted_microcents?: number; readonly remaining_microcents?: number };
  readonly paid_credit?: { readonly available_microcents?: number };
  readonly models?: readonly { readonly id: string; readonly usable?: boolean; readonly reason?: string | null }[];
  readonly current_month?: {
    readonly from?: string;
    readonly by_model?: readonly UsageRow[];
    readonly total_cost_microcents?: number;
    readonly total_service_fee_microcents?: number;
  };
}

export interface Billing {
  readonly plan: string;
  readonly payment_methods: readonly { readonly label: string | null; readonly default: boolean; readonly state: string | null }[];
  readonly last_invoice: Record<string, unknown> | null;
  readonly welcome_credit: { readonly state: string | null } | null;
  readonly manage_at: string;
}

interface RawStatus {
  readonly signed_in?: boolean;
  readonly name?: string;
  readonly subject_id?: string;
  readonly company_id?: string;
  readonly project_id?: string | null;
  readonly environment?: string;
  readonly platform?: string;
  readonly gateway?: string;
  readonly session_expires_at?: string | null;
  readonly default_model?: string;
}

function parseJson<T>(stdout: string, args: readonly string[]): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new AlranCliError(
      `\`alran ${args.join(' ')}\` printed no JSON. The installed Alran CLI is older than this extension expects; update it with "Alran: Update Alran CLI".`,
      { code: 0, stdout, stderr: '' },
    );
  }
}

async function json<T>(context: CliContext, args: readonly string[], timeoutMs = 30_000): Promise<T> {
  const full = [...args, '--json'];
  const result = await runCli(context, full, { timeoutMs });
  if (result.code !== 0) throw new AlranCliError(cliFailureMessage(result, full), result);
  return parseJson<T>(result.stdout, full);
}

async function checked(context: CliContext, args: readonly string[], timeoutMs = 30_000): Promise<string> {
  const result = await runCli(context, args, { timeoutMs });
  if (result.code !== 0) throw new AlranCliError(cliFailureMessage(result, args), result);
  return result.stdout.trim();
}

/** True when the CLI lacks the account commands (an Alran CLI before 0.2). */
export function isMissingCommand(result: CliResult): boolean {
  return /unknown command|unknown option|error: too many arguments/iu.test(`${result.stderr}${result.stdout}`);
}

export const account = {
  /** Who is signed in. A signed-out account is a normal answer, not an error. */
  async status(context: CliContext): Promise<AccountStatus> {
    const args = ['auth', 'status', '--json'];
    const result = await runCli(context, args, { timeoutMs: 30_000 });
    if (result.code !== 0 && result.code !== 2) {
      throw new AlranCliError(cliFailureMessage(result, args), result);
    }
    const raw = result.stdout.trim() ? parseJson<RawStatus>(result.stdout, args) : { signed_in: false };
    if (!raw.signed_in) return { signedIn: false };
    return {
      signedIn: true,
      ...(raw.name ? { name: raw.name } : {}),
      ...(raw.subject_id ? { subjectId: raw.subject_id } : {}),
      ...(raw.company_id ? { companyId: raw.company_id } : {}),
      projectId: raw.project_id ?? null,
      ...(raw.environment ? { environment: raw.environment } : {}),
      ...(raw.platform ? { platform: raw.platform } : {}),
      ...(raw.gateway ? { gateway: raw.gateway } : {}),
      sessionExpiresAt: raw.session_expires_at ?? null,
      ...(raw.default_model ? { defaultModel: raw.default_model } : {}),
    };
  },

  async companies(context: CliContext): Promise<{ current: string; companies: readonly Company[] }> {
    return json(context, ['auth', 'switch-company']);
  },

  switchCompany: (context: CliContext, company: string) =>
    checked(context, ['auth', 'switch-company', company]),

  async projects(context: CliContext): Promise<{ current: string | null; projects: readonly Project[] }> {
    return json(context, ['config', 'project']);
  },

  setProject: (context: CliContext, project: string) => checked(context, ['config', 'project', project]),

  clearProject: (context: CliContext) => checked(context, ['config', 'project', '--clear']),

  models: (context: CliContext) => json<OttiliModel[]>(context, ['models']),

  setDefaultModel: (context: CliContext, model: string) => checked(context, ['config', 'model', model]),

  usage: (context: CliContext) => json<Credits>(context, ['usage']),

  billing: (context: CliContext) => json<Billing>(context, ['billing']),

  logout: (context: CliContext) => checked(context, ['auth', 'logout'], 30_000),

  /** Signs in with an Ottili API key, handed over on stdin (never argv or disk). */
  async loginWithApiKey(context: CliContext, apiKey: string): Promise<string> {
    const args = ['auth', 'login', '--api-key', '--no-browser'];
    const result = await runCli(context, args, { input: `${apiKey}\n`, timeoutMs: 60_000 });
    if (result.code !== 0) throw new AlranCliError(cliFailureMessage(result, args), result);
    return result.stdout.trim();
  },
};

/** What model calls authenticate with, when no Platform session exists. */
export type Credential =
  | { readonly kind: 'session' }
  | { readonly kind: 'api-key'; readonly masked?: string }
  | { readonly kind: 'provider'; readonly name: string }
  | { readonly kind: 'none' };

export function credentialOf(status: AccountStatus | undefined, list: ProviderList | undefined): Credential {
  if (status?.signedIn) return { kind: 'session' };
  // `active` marks the default model's provider for custom providers, and the
  // selected credential source among the built-in Alran providers.
  const custom = list?.providers.find((provider) => provider.active && !provider.kind.startsWith('alran'));
  if (custom) return { kind: 'provider', name: custom.name };
  const apiKey = list?.providers.find((provider) => provider.kind === 'alran-api-key');
  if (list?.alranModelSource === 'alran_api_key' && apiKey?.hasApiKey) {
    return { kind: 'api-key', ...(apiKey.maskedApiKey ? { masked: apiKey.maskedApiKey } : {}) };
  }
  return { kind: 'none' };
}

// --- Interactive sign-in --------------------------------------------------------------------------------

export interface DeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresInMinutes?: number;
}

export interface LoginEvents {
  /** The browser sign-in page (loopback flow). */
  onBrowserUrl?(url: string): void;
  /** The code of the device flow, to confirm in any browser. */
  onDeviceCode?(code: DeviceCode): void;
}

export interface LoginOutcome {
  /** The CLI's closing line, for example "Signed in to the Ottili AI Platform (production)." */
  readonly message: string;
  readonly alreadySignedIn: boolean;
}

export interface LoginHandle {
  readonly done: Promise<LoginOutcome>;
  cancel(): void;
}

export class LoginCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled.');
    this.name = 'LoginCancelledError';
  }
}

/** Reads the sign-in instructions the CLI prints on stderr. */
export class LoginOutputParser {
  private buffer = '';
  private browserUrl: string | undefined;
  private deviceCode: DeviceCode | undefined;

  constructor(private readonly events: LoginEvents) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (!this.browserUrl) {
      // Only a finished line holds the whole URL; output can arrive in pieces.
      const match = /sign in with the Ottili Platform:\s*\r?\n\s*(https?:\/\/\S+)\r?\n/u.exec(this.buffer);
      if (match?.[1]) {
        this.browserUrl = match[1];
        this.events.onBrowserUrl?.(match[1]);
      }
    }
    if (!this.deviceCode && /(valid for|Waiting for you to confirm)[^\n]*\n/iu.test(this.buffer)) {
      const userCode = /enter the code:\s*([A-Z0-9][A-Z0-9-]{3,})/u.exec(this.buffer)?.[1];
      const verificationUri = /on any device:\s*\r?\n\s*(https?:\/\/\S+)/u.exec(this.buffer)?.[1];
      const complete = /open it directly:\s*(https?:\/\/\S+)/u.exec(this.buffer)?.[1];
      const minutes = /valid for (\d+) minute/u.exec(this.buffer)?.[1];
      if (userCode && verificationUri) {
        this.deviceCode = {
          userCode,
          verificationUri,
          ...(complete ? { verificationUriComplete: complete } : {}),
          ...(minutes ? { expiresInMinutes: Number(minutes) } : {}),
        };
        this.events.onDeviceCode?.(this.deviceCode);
      }
    }
  }

  get text(): string {
    return this.buffer;
  }
}

/**
 * Runs `alran auth login` without a terminal. The extension opens the browser
 * itself (it knows how to reach the person's browser from a remote window) and
 * shows the device code in the editor's UI.
 */
export function startLogin(
  context: CliContext,
  options: { readonly flow: 'browser' | 'device'; readonly force?: boolean },
  events: LoginEvents,
): LoginHandle {
  const args = [
    'auth',
    'login',
    '--no-browser',
    options.flow === 'device' ? '--device' : '--no-device',
    ...(options.force ? ['--force'] : []),
  ];
  const spec = spawnCommand(context.cli, [...(context.globalArgs ?? []), ...args]);
  const child = spawn(spec.command, [...spec.args], {
    cwd: context.cwd,
    env: { ...context.env, ALRAN_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatim === true,
  });
  const parser = new LoginOutputParser(events);
  let stdout = '';
  let cancelled = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => parser.push(chunk));
  const done = new Promise<LoginOutcome>((resolve, reject) => {
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (cancelled) {
        reject(new LoginCancelledError());
        return;
      }
      const result: CliResult = { code, stdout, stderr: parser.text };
      if (code !== 0) {
        reject(new AlranCliError(loginFailureMessage(result, args), result));
        return;
      }
      const message = stdout.trim().split(/\r?\n/u).pop() ?? 'Signed in.';
      resolve({ message, alreadySignedIn: /already logged in/iu.test(stdout) });
    });
  });
  return {
    done,
    cancel: () => {
      if (child.exitCode !== null) return;
      cancelled = true;
      // The device flow handles SIGINT as "cancelled"; the loopback flow just ends.
      child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000).unref();
    },
  };
}

function loginFailureMessage(result: CliResult, args: readonly string[]): string {
  // The instructions printed before the failure are not part of the reason.
  const reason = result.stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^(To sign in|and enter the code|or open it directly|The code is valid|Open this page|https?:\/\/)/u.test(line),
    )
    .pop();
  return reason ?? cliFailureMessage(result, args);
}

// --- Formatting -------------------------------------------------------------------------------------------

/** micro-USD → "$12.34", or "$0.0042" below a cent (the CLI's format). */
export function formatMicroUsd(micro: number | undefined): string {
  const value = Number(micro ?? 0) / 1_000_000;
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `${value < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
}

/** "$0.50 / $1.50 per 1M tokens" with the service fee when there is one. */
export function formatModelPrice(model: Pick<OttiliModel, 'input' | 'output' | 'feeBps'>): string {
  const fee = model.feeBps ? ` + ${String(model.feeBps / 100)} % fee` : '';
  return `${formatMicroUsd(model.input)} / ${formatMicroUsd(model.output)} per 1M tokens${fee}`;
}

/** The model key of an ACP model config value (`m:<provider>:<model>:u`), if it is one. */
export function modelKeyFromConfigValue(value: string): string | undefined {
  const [prefix, provider, model] = value.split(':');
  if (prefix !== 'm' || !provider || !model) return undefined;
  try {
    return `${decodeURIComponent(provider)}/${decodeURIComponent(model)}`;
  } catch {
    return undefined;
  }
}
