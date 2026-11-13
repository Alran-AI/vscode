import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A scripted OpenAI-compatible provider plus an isolated Alran data directory,
 * so tests can drive the real `alran acp` runtime without an account or network.
 * Behaviour is selected by markers in the latest user message.
 */
export interface Fixture {
  readonly cliPath: string;
  /** Origin of the scripted model provider (`<origin>/v1/chat/completions`). */
  readonly modelOrigin: string;
  readonly workspace: string;
  readonly outsideDir: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requests: string[];
  cleanup(): Promise<void>;
}

/** The test store: `test/fixtures/store/index.json` and its archives. */
export const STORE_FIXTURE = path.resolve(process.cwd(), 'test', 'fixtures', 'store');

/**
 * A scratch directory. README shots name it (ALRAN_E2E_ROOT), so no random
 * temp name shows up in a permission card; it must not exist or be empty.
 */
function createRoot(): string {
  const named = process.env.ALRAN_E2E_ROOT;
  if (!named) return mkdtempSync(path.join(tmpdir(), 'alran-vscode-test-'));
  if (existsSync(named) && readdirSync(named).length > 0) throw new Error(`ALRAN_E2E_ROOT ${named} is not empty.`);
  mkdirSync(named, { recursive: true });
  return named;
}

export function findCli(): string | undefined {
  const candidates = [
    process.env.ALRAN_TEST_CLI,
    path.resolve(process.cwd(), '..', 'alran-code', 'dist', 'cli.js'),
  ];
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
}

export async function createFixture(): Promise<Fixture> {
  const cliPath = findCli();
  if (!cliPath) throw new Error('Set ALRAN_TEST_CLI to a built Alran CLI.');
  const root = createRoot();
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'billing-api');
  const outsideDir = path.join(root, 'shared');
  const home = path.join(root, 'home');
  for (const directory of [dataDir, workspace, outsideDir, home]) mkdirSync(directory);
  writeFileSync(path.join(workspace, 'a.txt'), 'line one\nline two\nline three\n');
  mkdirSync(path.join(workspace, 'src'));
  writeFileSync(path.join(workspace, 'src', 'date.ts'), DEMO_SOURCE);
  // A small, believable project around the demo file: what the Explorer and the README shots show.
  mkdirSync(path.join(workspace, 'test'));
  writeFileSync(
    path.join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'billing-api', version: '1.4.0', private: true, type: 'module', scripts: { test: 'vitest run', build: 'tsc' } }, null, 2)}\n`,
  );
  writeFileSync(path.join(workspace, 'README.md'), '# billing-api\n\nInvoices, payment runs and the dates they depend on.\n');
  writeFileSync(
    path.join(workspace, 'src', 'invoice.ts'),
    "import { formatDate, parseDate } from './date';\n\nexport function dueDate(issued: string, days: number): string {\n  const date = parseDate(issued);\n  date.setUTCDate(date.getUTCDate() + days);\n  return formatDate(date);\n}\n",
  );
  writeFileSync(
    path.join(workspace, 'test', 'date.test.ts'),
    "import { expect, it } from 'vitest';\nimport { parseDate } from '../src/date';\n\nit('parses an ISO date', () => {\n  expect(parseDate('2026-11-13').toISOString()).toBe('2026-11-13T00:00:00.000Z');\n});\n",
  );

  // README runs call the scripted provider something a reader would not take for a test.
  const providerKey = process.env.ALRAN_E2E_PROVIDER || 'fixture';
  const modelId = providerKey === 'fixture' ? 'fixture' : 'local-model';
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (raw += chunk));
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      void respond(JSON.parse(raw) as ChatBody, response, requests, { workspace, outsideDir });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${String(port)}`;

  // YAML is a superset of JSON, so no YAML dependency is needed here.
  writeFileSync(
    path.join(dataDir, 'config.yaml'),
    JSON.stringify({
      defaultModel: `custom_provider:${providerKey}/${modelId}`,
      permission: { mode: 'default' },
      // Programmatic Tool Calling is opt-in; the run_code test needs it.
      beta: { ptc: true },
      custom_provider: {
        [providerKey]: {
          name: providerKey === 'fixture' ? 'fixture' : 'Local model',
          kind: 'custom',
          enabled: true,
          api: 'openai-completions',
          options: { apiKey: 'synthetic-key', baseURL: `${origin}/v1`, authMode: 'api-key' },
          models: { [modelId]: { limit: { context: 32768, output: 4096 } } },
        },
      },
    }),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    ALRAN_DATA_DIR: dataDir,
    MAVIS_DATA_DIR: dataDir,
    ALRAN_TEST_ALLOWED_ORIGIN: origin,
    ALRAN_DISABLE_TELEMETRY: '1',
    // A tiny offline store (two Plugins, three Skills), so no test asks the network for one.
    ALRAN_STORE_URL: process.env.ALRAN_E2E_STORE || STORE_FIXTURE,
  };
  return {
    cliPath,
    modelOrigin: origin,
    workspace,
    outsideDir,
    dataDir,
    env,
    requests,
    cleanup: () => close(server, root),
  };
}

async function close(server: Server, root: string): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}

interface ChatBody {
  readonly stream?: boolean;
  readonly messages: readonly { role: string; content: unknown }[];
}

function lastUserText(message: { content: unknown } | undefined): string {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

async function respond(
  body: ChatBody,
  response: ServerResponse,
  requests: string[],
  paths: { workspace: string; outsideDir: string },
): Promise<void> {
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        model: 'fixture',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  const last = body.messages[body.messages.length - 1];
  const text = lastUserText(last);
  requests.push(text);
  const failure = /DO_FAIL_(\d{3})/u.exec(last?.role === 'user' ? text : '');
  if (failure?.[1]) {
    const status = Number(failure[1]);
    const errors: Record<number, { code: string; message: string; type: string }> = {
      401: { code: 'unauthenticated', type: 'authentication_error', message: 'The session has ended.' },
      402: {
        code: 'free_credit_model_restricted',
        type: 'insufficient_quota',
        message: 'Welcome credit covers Ottili Werk only. Add purchased credit to use this model.',
      },
      429: { code: 'rate_limited', type: 'rate_limit_error', message: 'Too many requests.' },
      500: { code: 'upstream_error', type: 'server_error', message: 'The upstream model failed.' },
    };
    const error = errors[status] ?? { code: 'error', type: 'error', message: 'Failed.' };
    response
      .writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '1' } : {}) })
      .end(JSON.stringify({ error }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (chunk: object) =>
    response.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'fixture', ...chunk })}\n\n`,
    );
  const finish = (reason: string) => {
    send({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    response.end('data: [DONE]\n\n');
  };
  const say = async (reply: string, delayMs = 0) => {
    for (const part of reply.match(/[\s\S]{1,8}/gu) ?? []) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: part } }] });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    finish('stop');
  };
  const callTool = (name: string, args: object) => {
    send({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${String(Date.now())}_${String(Math.random()).slice(2, 8)}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
    finish('tool_calls');
  };

  const file = (name: string) => path.join(paths.workspace, name);
  const lastUser = lastUserText([...body.messages].reverse().find((message) => message.role === 'user'));
  if (lastUser.includes('DO_DEMO') || lastUser.includes('reject invalid dates')) {
    const toolTurns = body.messages.slice(body.messages.findLastIndex((message) => message.role === 'user')).filter((message) => message.role === 'tool').length;
    if (toolTurns === 0) {
      callTool('edit', { file_path: file('src/date.ts'), old_string: DEMO_OLD, new_string: DEMO_NEW });
    } else {
      await say(DEMO_REPLY, 4);
    }
    return;
  }
  if (last?.role === 'tool' && /permission denied/iu.test(text)) {
    await say(
      'Understood, I left the shared folder alone. The change stays in the workspace.',
    );
  } else if (last?.role === 'tool') {
    await say(`Tool done: ${stripReminder(text).slice(0, 48)}`);
  } else if (text.includes('<questionnaire-response>') || text.includes('Q: ')) {
    await say(`Thanks for answering. ${/A: ([^"\\]+)/u.exec(text)?.[1] ?? ''}`.trim());
  } else if (text.includes('DO_EDIT')) {
    callTool('edit', { file_path: file('a.txt'), old_string: 'line two', new_string: 'line TWO' });
  } else if (text.includes('DO_WRITE')) {
    callTool('write', { path: file('created.txt'), content: 'brand new\n' });
  } else if (/release notes to the shared folder/iu.test(text)) {
    callTool('write', {
      path: path.join(paths.outsideDir, 'RELEASE_NOTES.md'),
      content: '# billing-api 1.4.0\n\n- parseDate rejects invalid dates\n',
    });
  } else if (text.includes('DO_OUTSIDE') || text.includes('shared folder')) {
    callTool('write', { path: path.join(paths.outsideDir, 'guarded.txt'), content: 'outside\n' });
  } else if (text.includes('DO_RUNCODE')) {
    callTool('run_code', {
      description: 'edit in a program',
      code: `await tools.edit({file_path:${JSON.stringify(file('a.txt'))},old_string:'line one',new_string:'line ONE'}); return (await tools.bash({command:'echo from-program'}));`,
    });
  } else if (text.includes('DO_ASK')) {
    callTool('ask_user', {
      title: 'Pick a color',
      steps: [
        {
          id: 'color',
          header: 'Color',
          question: 'Which color?',
          options: [
            { label: 'Red', description: 'warm' },
            { label: 'Blue', description: 'cool' },
          ],
        },
      ],
    });
  } else if (text.includes('DO_SLOW')) {
    await say('working '.repeat(40), 30);
  } else if (text.includes('DO_THINK')) {
    send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'pondering it' } }] });
    await say('Thought about it.');
  } else {
    await say(`Echo: ${stripReminder(text).slice(-40)}`);
  }
}

function stripReminder(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, '').trim();
}

const DEMO_OLD = `export function parseDate(input: string): Date {
  return new Date(input);
}`;

const DEMO_NEW = `const ISO_DATE = /^(\\d{4})-(\\d{2})-(\\d{2})$/;

export function parseDate(input: string): Date {
  const match = ISO_DATE.exec(input.trim());
  if (!match) {
    throw new RangeError(\`Expected YYYY-MM-DD: \${input}\`);
  }
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) {
    throw new RangeError(\`No such date: \${input}\`);
  }
  return date;
}`;

const DEMO_SOURCE = `/** Parses the dates our API sends. */
${DEMO_OLD}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
`;

const DEMO_REPLY = `\`parseDate\` accepted anything \`new Date()\` could guess, so \`"2026-02-30"\` quietly became March 2. It now:

- accepts only \`YYYY-MM-DD\` and throws a \`RangeError\` that names the bad input,
- builds the date in UTC, so the result no longer depends on the machine's time zone,
- rejects dates that do not exist, such as February 30.

\`\`\`ts
parseDate('2026-11-13'); // 2026-11-13T00:00:00.000Z
parseDate('2026-02-30'); // RangeError: No such date: 2026-02-30
\`\`\`

Run the tests with \`npm test\` to confirm; the change is in the **Changes** view if you want to review or revert it.`;
