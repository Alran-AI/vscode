import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A scripted OpenAI-compatible provider plus an isolated Alran data directory,
 * so tests can drive the real `alran acp` runtime without an account or network.
 * Behaviour is selected by markers in the latest user message.
 */
export interface Fixture {
  readonly cliPath: string;
  readonly workspace: string;
  readonly outsideDir: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requests: string[];
  cleanup(): Promise<void>;
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
  const root = mkdtempSync(path.join(tmpdir(), 'alran-vscode-test-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const outsideDir = path.join(root, 'outside');
  const home = path.join(root, 'home');
  for (const directory of [dataDir, workspace, outsideDir, home]) mkdirSync(directory);
  writeFileSync(path.join(workspace, 'a.txt'), 'line one\nline two\nline three\n');

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
      defaultModel: 'custom_provider:fixture/fixture',
      permission: { mode: 'default' },
      custom_provider: {
        fixture: {
          name: 'fixture',
          kind: 'custom',
          enabled: true,
          api: 'openai-completions',
          options: { apiKey: 'synthetic-key', baseURL: `${origin}/v1`, authMode: 'api-key' },
          models: { fixture: { limit: { context: 32768, output: 4096 } } },
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
    ALRAN_TEST_MANAGED_OFFLINE: '1',
    ALRAN_DISABLE_TELEMETRY: '1',
  };
  return {
    cliPath,
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
  if (last?.role === 'tool') {
    await say(`Tool done: ${stripReminder(text).slice(0, 48)}`);
  } else if (text.includes('<questionnaire-response>') || text.includes('Q: ')) {
    await say(`Thanks for answering. ${/A: ([^"\\]+)/u.exec(text)?.[1] ?? ''}`.trim());
  } else if (text.includes('DO_EDIT')) {
    callTool('edit', { file_path: file('a.txt'), old_string: 'line two', new_string: 'line TWO' });
  } else if (text.includes('DO_WRITE')) {
    callTool('write', { path: file('created.txt'), content: 'brand new\n' });
  } else if (text.includes('DO_OUTSIDE')) {
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
