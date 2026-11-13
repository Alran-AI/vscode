import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted Ottili Platform and AI Gateway on one loopback port, so the real
 * `alran auth|config|models|usage|billing` commands run without an account:
 * the browser sign-in (OIDC handoff), the device sign-in (RFC 8628), companies,
 * projects, credits and billing.
 */
export interface FakeOttili {
  readonly origin: string;
  /** Environment that points the CLI at this server. */
  readonly env: NodeJS.ProcessEnv;
  /** The device code the person would confirm; `approveDevice` confirms it. */
  approveDevice(): void;
  /** Calls by path, for assertions. */
  readonly calls: string[];
  /** Model calls through the Gateway: model id and the attribution headers. */
  readonly completions: { model: string; company?: string; project?: string }[];
  /** Mutable account state. */
  readonly state: {
    company: string;
    session: string | undefined;
    revoked: string[];
    paidCredit: number;
    welcomeCredit: number;
  };
  close(): Promise<void>;
}

const COMPANIES = [
  { company_id: 'cmp-acme', slug: 'acme', status: 'active', roles: ['owner'] },
  { company_id: 'cmp-globex', slug: 'globex', status: 'active', roles: ['member'] },
];

const PROJECTS = [
  { project_id: 'prj-web', name: 'Website', status: 'active', access: { role: 'admin' } },
  { project_id: 'prj-api', name: 'API', status: 'active', access: { role: 'member' } },
];

export async function createFakeOttili(options: { readonly upstream?: string } = {}): Promise<FakeOttili> {
  const calls: string[] = [];
  const completions: FakeOttili['completions'] = [];
  const state: FakeOttili['state'] = {
    company: 'cmp-acme',
    session: undefined,
    revoked: [],
    paidCredit: 0,
    welcomeCredit: 4_800_000,
  };
  let deviceApproved = false;
  let sessionCounter = 0;
  let origin = '';

  const newSession = () => {
    sessionCounter += 1;
    state.session = `sess-${String(sessionCounter)}`;
    return state.session;
  };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const data = (response: ServerResponse, body: unknown) => send(response, 200, { data: body });

  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers['x-ottili-session'] ?? request.headers.authorization?.replace(/^Bearer /u, '');
    return !!state.session && header === state.session;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', origin);
    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    calls.push(route);
    const body = await readBody(request);

    // Test controls, for an end-to-end run in another process.
    if (route === 'POST /__test/approve') {
      deviceApproved = true;
      return send(response, 200, { ok: true });
    }
    if (route === 'GET /__test/state') return send(response, 200, { ...state, calls, completions });

    // Browser sign-in: the Platform hands the browser back with a one-time code.
    if (route === 'GET /v2/auth/oidc/login') {
      const target = new URL(url.searchParams.get('return_to') ?? '');
      target.searchParams.set('ottili_handoff', 'handoff-1');
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (route === 'POST /v2/auth/sessions/handoff') {
      if (body.code !== 'handoff-1') return send(response, 400, { error: { code: 'invalid_code' } });
      return data(response, { session_id: newSession(), company_id: state.company, subject_id: 'subj-1' });
    }
    if (route === 'GET /v2/version') return data(response, { version: 'fake' });

    // Device sign-in, served by the Gateway.
    if (route === 'POST /v1/auth/device') {
      deviceApproved = false;
      return send(response, 200, {
        device_code: 'device-secret',
        user_code: 'BCDF-GHJK',
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?user_code=BCDF-GHJK`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (route === 'POST /v1/auth/device/token') {
      if (!deviceApproved) return send(response, 400, { error: 'authorization_pending' });
      return send(response, 200, {
        session_id: newSession(),
        company_id: state.company,
        subject_id: 'subj-1',
        platform_base_url: origin,
      });
    }

    if (url.pathname.startsWith('/v2/') || url.pathname.startsWith('/v1/')) {
      if (!authorized(request)) return send(response, 401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
    }

    if (route === 'POST /v1/chat/completions') {
      const model = String(body.model ?? '');
      completions.push({
        model,
        ...(typeof request.headers['x-ottili-company'] === 'string' ? { company: request.headers['x-ottili-company'] } : {}),
        ...(typeof request.headers['x-ottili-project'] === 'string' ? { project: request.headers['x-ottili-project'] } : {}),
      });
      if (model.startsWith('anthropic/') && state.paidCredit <= 0) {
        return send(response, 402, {
          error: {
            code: 'free_credit_model_restricted',
            type: 'insufficient_quota',
            message: 'Claude models are paid with purchased credit. Your welcome credit covers Ottili Werk.',
          },
        });
      }
      if (!options.upstream) return send(response, 503, { error: { code: 'unavailable', message: 'No upstream.' } });
      const upstream = await fetch(`${options.upstream}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-key' },
        body: JSON.stringify(body),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      const reader = upstream.body?.getReader();
      for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) response.write(part.value);
      response.end();
      return;
    }
    if (route === 'GET /v2/profile') {
      return data(response, { profile: { display_name: 'Test Person', subject_id: 'subj-1' } });
    }
    if (url.pathname.startsWith('/v2/auth/sessions/')) {
      if (request.method === 'DELETE') {
        state.revoked.push(url.pathname.split('/').pop() ?? '');
        state.session = undefined;
        response.writeHead(204).end();
        return;
      }
      return data(response, { expires_at: '2026-12-31T00:00:00.000Z' });
    }
    if (route === 'GET /v2/companies') return data(response, { companies: COMPANIES });
    if (route === 'POST /v2/auth/company') {
      state.company = String(body.company_id);
      return data(response, { session: { session_id: state.session, company_id: state.company } });
    }
    if (route === 'GET /v2/projects') return data(response, { items: PROJECTS });
    if (route === 'GET /v2/billing/subscription') return data(response, { subscription: null });
    if (route === 'GET /v2/billing/payment-methods') {
      return data(response, { payment_methods: [{ display_label: 'Visa •••• 4242', is_default: true, state: 'active' }] });
    }
    if (route === 'GET /v2/billing/invoices') return data(response, { invoices: [] });
    if (route === 'GET /v2/billing/welcome-credit') return data(response, { welcome_credit: { state: 'granted' } });
    if (route === 'GET /v1/credits') {
      const paid = state.paidCredit > 0;
      return send(response, 200, {
        currency: 'usd',
        available_microcents: state.welcomeCredit + state.paidCredit,
        reserved_microcents: 0,
        free_credit: { granted_microcents: 5_000_000, remaining_microcents: state.welcomeCredit },
        paid_credit: { available_microcents: state.paidCredit },
        models: [
          { id: 'ottili/werk-1.1', usable: true },
          { id: 'anthropic/claude-sonnet-5.5', usable: paid, reason: paid ? null : 'requires_paid_credit' },
          { id: 'anthropic/claude-opus-5.5', usable: paid, reason: paid ? null : 'requires_paid_credit' },
        ],
        current_month: {
          from: '2026-11-01T00:00:00.000Z',
          by_model: [
            { model: 'ottili/werk-1.1', requests: 12, input_tokens: 40_000, output_tokens: 8_000, cost_microcents: 200_000 },
          ],
          total_cost_microcents: 200_000,
        },
      });
    }
    send(response, 404, { error: { code: 'not_found', message: route } });
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => send(response, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const callbackPort = await freePort();

  return {
    origin,
    env: {
      OTTILI_PLATFORM_URL: origin,
      ALRAN_PLATFORM_BASE_URL_PROD: origin,
      ALRAN_PLATFORM_BASE_URL_DEV: origin,
      ALRAN_API_BASE: `${origin}/v1`,
      ALRAN_OIDC_CALLBACK_URI: `http://127.0.0.1:${String(callbackPort)}/callback`,
      ALRAN_NO_UPDATE_CHECK: '1',
    },
    approveDevice: () => {
      deviceApproved = true;
    },
    calls,
    completions,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  request.setEncoding('utf8');
  for await (const chunk of request) raw += chunk as string;
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Follows the sign-in URL like a browser would, through the loopback callback. */
export async function completeBrowserSignIn(url: string): Promise<number> {
  let next = url;
  for (let hops = 0; hops < 5; hops += 1) {
    const response = await fetch(next, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      next = new URL(location, next).toString();
      continue;
    }
    await response.text();
    return response.status;
  }
  throw new Error('Too many redirects');
}
