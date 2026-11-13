/**
 * Turns a failure the agent reports into words a person can act on. The ACP
 * layer only forwards the runtime's raw text ("Internal error: Alran Code
 * Runtime failed: BYOK provider x upstream error: 402 …"), so the kind of
 * failure is read from that text. Free of `vscode` and Node imports.
 */

export type FailureKind =
  | 'auth'
  | 'provider-auth'
  | 'model-restricted'
  | 'credits'
  | 'rate-limit'
  | 'unavailable'
  | 'network'
  | 'context-limit'
  | 'output-limit'
  | 'invalid-request'
  | 'access-denied'
  | 'content-safety'
  | 'unknown';

export type FailureAction =
  | 'retry'
  | 'sign-in'
  | 'add-credits'
  | 'show-usage'
  | 'switch-model'
  | 'use-werk'
  | 'provider-settings'
  | 'compact'
  | 'new-session'
  | 'show-logs';

export interface FailureView {
  readonly kind: FailureKind;
  readonly title: string;
  readonly detail?: string;
  readonly actions: readonly FailureAction[];
  readonly retryable: boolean;
  /** The provider of a bring-your-own-key route, when the failure came from one. */
  readonly provider?: string;
  /** HTTP status of the upstream answer, when the text names one. */
  readonly status?: number;
}

const PREFIXES = [
  /^Internal error:\s*/iu,
  /^Alran Code Runtime failed:?\s*/iu,
  /^Error:\s*/u,
  /^LLM request failed:?\s*/iu,
];

const BYOK = /^BYOK provider (?<provider>.+?) upstream error:\s*/u;

/** The runtime's text without the layers of prefixes each component adds. */
export function stripFailurePrefixes(raw: string): { readonly text: string; readonly provider?: string } {
  let text = raw.trim();
  let provider: string | undefined;
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of PREFIXES) {
      if (prefix.test(text)) {
        text = text.replace(prefix, '');
        changed = true;
      }
    }
    const byok = BYOK.exec(text);
    if (byok?.groups?.provider) {
      provider = byok.groups.provider.replace(/^custom_provider:/u, '');
      text = text.replace(BYOK, '');
      changed = true;
    }
  }
  return { text: text.trim(), ...(provider ? { provider } : {}) };
}

function statusOf(text: string): number | undefined {
  const match =
    /^(\d{3})\b/u.exec(text) ??
    /\b(?:HTTP|status(?: code)?|statusCode)[\s:=]*(\d{3})\b/iu.exec(text) ??
    /"status"\s*:\s*(\d{3})/u.exec(text);
  const status = match?.[1] ? Number(match[1]) : undefined;
  return status !== undefined && status >= 400 && status < 600 ? status : undefined;
}

/** The message inside a JSON error body, when the text carries one. */
function innerMessage(text: string): string {
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { error?: { message?: unknown } | string; message?: unknown };
      const error = parsed.error;
      const message =
        typeof error === 'object' && error && typeof error.message === 'string'
          ? error.message
          : typeof error === 'string'
            ? error
            : typeof parsed.message === 'string'
              ? parsed.message
              : undefined;
      if (message) return message;
    } catch {
      // Not JSON after all; use the text as it is.
    }
  }
  return text.replace(/^\d{3}\s+/u, '');
}

function sentence(text: string): string | undefined {
  const trimmed = text.trim().replace(/\s+/gu, ' ');
  if (!trimmed) return undefined;
  const clipped = trimmed.length > 400 ? `${trimmed.slice(0, 397)}…` : trimmed;
  return /[.!?…]$/u.test(clipped) ? clipped : `${clipped}.`;
}

export function describeFailure(raw: string): FailureView {
  const { text, provider } = stripFailurePrefixes(raw);
  const status = statusOf(text);
  const message = innerMessage(text);
  const lower = text.toLowerCase();
  const reason = sentence(message);
  const base = {
    ...(provider ? { provider } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  const withReason = (detail: string) => (reason && !detail.includes(reason) ? `${detail} ${reason}` : detail);

  if (/free_credit_model_restricted|requires_paid_credit|welcome credit covers/iu.test(text)) {
    return {
      ...base,
      kind: 'model-restricted',
      title: 'This model needs purchased credit',
      detail: 'Your welcome credit covers Ottili Werk. Switch to Werk, or add credit to use Claude models.',
      actions: ['use-werk', 'add-credits'],
      retryable: false,
    };
  }
  if (
    status === 402 ||
    /insufficient_quota|insufficient (credits?|balance|funds)|credits? (exhausted|depleted)|out of credits?|usage limit|payment required/iu.test(
      text,
    )
  ) {
    return provider
      ? {
          ...base,
          kind: 'credits',
          title: `${provider} reports that the account has no credit left`,
          ...(reason ? { detail: reason } : {}),
          actions: ['provider-settings', 'switch-model'],
          retryable: false,
        }
      : {
          ...base,
          kind: 'credits',
          title: 'Your Ottili credit is used up',
          detail: withReason('Add credit to keep working, or check this month’s spending.'),
          actions: ['add-credits', 'show-usage'],
          retryable: false,
        };
  }
  if (status === 401 || /\bunauthori[sz]ed\b|invalid api key|incorrect api key|session has ended|not signed in|login required/iu.test(text)) {
    return provider
      ? {
          ...base,
          kind: 'provider-auth',
          title: `${provider} rejected the API key`,
          detail: 'Check the key and endpoint of this provider, then send the message again.',
          actions: ['provider-settings', 'switch-model'],
          retryable: false,
        }
      : {
          ...base,
          kind: 'auth',
          title: 'Your Ottili session has ended',
          detail: 'Sign in again to continue. Your message is kept.',
          actions: ['sign-in', 'retry'],
          retryable: true,
        };
  }
  if (status === 403 || /\bforbidden\b|access denied|permission denied by the provider/iu.test(text)) {
    return {
      ...base,
      kind: 'access-denied',
      title: provider ? `${provider} denied access to this model` : 'Access to this model was denied',
      detail: withReason('Check that your account or key may use the selected model.'),
      actions: ['switch-model', provider ? 'provider-settings' : 'show-usage'],
      retryable: false,
    };
  }
  if (status === 429 || /rate.?limit|too many requests/iu.test(text)) {
    return {
      ...base,
      kind: 'rate-limit',
      title: provider ? `${provider} is rate limiting requests` : 'Too many requests right now',
      detail: 'Wait a moment, then try again.',
      actions: ['retry', 'switch-model'],
      retryable: true,
    };
  }
  if (
    /context.{0,20}(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long/iu.test(
      text,
    )
  ) {
    return {
      ...base,
      kind: 'context-limit',
      title: 'The conversation no longer fits the model’s context',
      detail: 'Compact the conversation to summarize earlier history, or start a new session.',
      actions: ['compact', 'new-session'],
      retryable: false,
    };
  }
  if (/max(imum)?[_ ]output|output (token )?limit|max_tokens/iu.test(lower) && !/context/iu.test(lower)) {
    return {
      ...base,
      kind: 'output-limit',
      title: 'The response reached the model’s output limit',
      detail: 'Lower the thinking effort or ask for a shorter answer, then try again.',
      actions: ['retry'],
      retryable: true,
    };
  }
  if (/content (filter|policy|review)|safety system|policy violation/iu.test(text)) {
    return {
      ...base,
      kind: 'content-safety',
      title: 'The response was stopped by content safety checks',
      detail: 'Rephrase the message, then send it again.',
      actions: [],
      retryable: false,
    };
  }
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|network error|getaddrinfo|connection (closed|terminated|reset)|^terminated\.?$/iu.test(
      text,
    )
  ) {
    return {
      ...base,
      kind: 'network',
      title: provider ? `Cannot reach ${provider}` : 'Cannot reach the Ottili AI Gateway',
      detail: 'Check your network connection, then try again.',
      actions: ['retry'],
      retryable: true,
    };
  }
  if (
    (status !== undefined && status >= 500) ||
    /overloaded|temporarily unavailable|service unavailable|bad gateway|upstream_error|server_error/iu.test(text)
  ) {
    return {
      ...base,
      kind: 'unavailable',
      title: provider ? `${provider} is temporarily unavailable` : 'The model is temporarily unavailable',
      detail: withReason('Try again in a moment.'),
      actions: ['retry', 'switch-model'],
      retryable: true,
    };
  }
  if (status === 400 || status === 404 || status === 422 || /invalid_request|bad request|model not found|unknown model/iu.test(text)) {
    return {
      ...base,
      kind: 'invalid-request',
      title: provider ? `${provider} rejected the request` : 'The model rejected the request',
      ...(reason ? { detail: reason } : {}),
      actions: ['compact', 'switch-model', 'show-logs'],
      retryable: false,
    };
  }
  return {
    ...base,
    kind: 'unknown',
    title: 'The response failed',
    ...(reason ? { detail: reason } : {}),
    actions: ['retry', 'show-logs'],
    retryable: true,
  };
}

/** Why the agent process could not start, in plain words. */
export function describeStartupFailure(raw: string): { readonly title: string; readonly detail: string; readonly hint?: 'node' | 'reinstall' } {
  const text = raw.trim();
  const nodeVersion =
    /requires Node(?:\.js)? ([\d.]+)|Node\.js ([\d.]+) or newer|Unsupported Node|engine "node" is incompatible|SyntaxError: Unexpected token|ERR_REQUIRE_ESM|Cannot use import statement/iu.exec(
      text,
    );
  if (nodeVersion) {
    return {
      title: 'Alran needs a newer Node.js',
      detail:
        'Alran Code runs on Node.js 22.19 or newer (22.x), 24.2+, 25 or 26. Install a current Node.js, or set "alran.nodePath" to one, then try again.',
      hint: 'node',
    };
  }
  if (/Cannot find module|MODULE_NOT_FOUND|ENOENT/u.test(text)) {
    return {
      title: 'The Alran CLI installation is incomplete',
      detail: 'Reinstall the Alran CLI, then try again.',
      hint: 'reinstall',
    };
  }
  if (/EACCES|permission denied/iu.test(text)) {
    return {
      title: 'The Alran CLI could not be started',
      detail: 'The file is not executable for this user. Check its permissions, or reinstall the CLI.',
      hint: 'reinstall',
    };
  }
  const lastLine = text.split(/\r?\n/u).filter((line) => line.trim()).pop() ?? '';
  return {
    title: 'The Alran agent could not start',
    detail: lastLine ? `It stopped with: ${lastLine}` : 'It stopped without saying why. The logs have the details.',
  };
}
