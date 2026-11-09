import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AlranAgent } from '../../src/acp/agent';
import { resolveAlranCli } from '../../src/acp/binary';
import { plugins, providers, type CliContext } from '../../src/core/cli';
import { SessionManager, type ManagerListener } from '../../src/core/manager';
import type { SessionController } from '../../src/core/session';
import type { PermissionItem, QuestionItem, ToolItem } from '../../src/shared/types';
import { createFixture, findCli, type Fixture } from '../fixtures/fakeModel';

/** Drives the real `alran acp` through the extension's own protocol layer. */
describe.skipIf(!findCli())('SessionManager against the real Alran runtime', () => {
  let fixture: Fixture;
  let manager: SessionManager;
  let session: SessionController;
  let cliContext: CliContext;
  const attention: string[] = [];

  beforeAll(async () => {
    fixture = await createFixture();
    const cli = await resolveAlranCli({ configuredPath: fixture.cliPath, env: fixture.env });
    cliContext = { cli, cwd: fixture.workspace, env: fixture.env };
    const listener: ManagerListener = {
      connection: () => undefined,
      tabs: () => undefined,
      items: () => undefined,
      meta: () => undefined,
      snapshot: () => undefined,
      changes: () => undefined,
      attention: (event) => attention.push(event.kind),
      turn: () => undefined,
      log: () => undefined,
    };
    manager = new SessionManager(
      {
        createAgent: (handlers) =>
          Promise.resolve(new AlranAgent({ cli, cwd: fixture.workspace, env: fixture.env }, handlers)),
        mcpServers: () => [],
        enterWhileRunning: () => 'steer',
      },
      listener,
    );
    session = await manager.newSession(fixture.workspace);
    await session.setConfigOption('permissionMode', 'default');
  }, 60_000);

  afterAll(async () => {
    await manager?.dispose();
    await fixture?.cleanup();
  });

  const send = (text: string, target: SessionController = session) =>
    target.submit({ text, attachments: [] });

  const toolsNamed = (name: string, target: SessionController = session) =>
    target.model.items.filter((item): item is ToolItem => item.kind === 'tool' && item.name === name);

  it('creates a session with modes, config options and commands', async () => {
    await waitFor(() => session.meta.commands.some((command) => command.source === 'skill'));
    expect(session.meta.modes.map((mode) => mode.id)).toEqual(['default', 'plan']);
    expect(session.meta.config.map((option) => option.id)).toContain('permissionMode');
    expect(session.meta.config.map((option) => option.id)).toContain('model');
    expect(session.meta.commands.map((command) => command.name)).toContain('compact');
    expect(session.meta.status).toBe('idle');
  });

  it('streams a reply and settles the turn', async () => {
    await send('hello there');
    const reply = session.model.items.at(-1);
    expect(reply).toMatchObject({ kind: 'assistant', streaming: false });
    expect(session.model.lastAssistantText()).toContain('Echo');
    expect(session.meta.status).toBe('idle');
    expect(attention).toContain('turn-complete');
  });

  it('runs agent slash commands', async () => {
    await send('/usage');
    expect(session.model.lastAssistantText()).toContain('Session usage');
  });

  it('captures command output without touching the transcript', async () => {
    const before = session.model.items.length;
    const output = await session.captureCommand('/mcp');
    expect(output).toMatch(/MCP servers|No configured MCP/u);
    expect(session.model.items.length).toBe(before);
  });

  it('tracks an edit, reconstructs the original, and reverts it', async () => {
    const target = path.join(fixture.workspace, 'a.txt');
    await send('DO_EDIT please');
    const [tool] = toolsNamed('edit');
    expect(tool?.status).toBe('completed');
    expect(tool?.patch).toContain('+line TWO');
    expect(readFileSync(target, 'utf8')).toContain('line TWO');
    await waitFor(() => session.changes.get(target)?.before?.includes('line two') === true);
    await session.changes.revert(target);
    expect(readFileSync(target, 'utf8')).toBe('line one\nline two\nline three\n');
  });

  it('marks a created file so that revert removes it', async () => {
    const target = path.join(fixture.workspace, 'created.txt');
    await send('DO_WRITE please');
    expect(existsSync(target)).toBe(true);
    await waitFor(() => session.changes.get(target)?.before === null);
    await session.changes.revert(target);
    expect(existsSync(target)).toBe(false);
  });

  it('nests Programmatic Tool Calling children under run_code', async () => {
    await send('DO_RUNCODE please');
    const [program] = toolsNamed('run_code');
    const [child] = toolsNamed('edit').slice(-1);
    expect(program?.status).toBe('completed');
    expect(child?.parentId).toBe(program?.id);
    const target = path.join(fixture.workspace, 'a.txt');
    await waitFor(() => session.changes.get(target) !== undefined);
    await session.changes.revert(target).catch(() => undefined);
  });

  it('shows a permission request and acts on the decision', async () => {
    const outside = path.join(fixture.outsideDir, 'guarded.txt');
    const turn = send('DO_OUTSIDE please');
    const request = await waitForItem<PermissionItem>(session, 'permission');
    expect(session.meta.status).toBe('awaiting-input');
    expect(request.options.map((option) => option.id)).toContain('allow-once');
    expect(request.options.map((option) => option.id)).toContain('deny');
    session.answerPermission(request.id, 'allow-once');
    await turn;
    expect(existsSync(outside)).toBe(true);
    expect(request.resolution).toBe('Allow once');
  });

  it('asks a questionnaire and streams the continuation', async () => {
    const turn = send('DO_ASK please');
    const question = await waitForItem<QuestionItem>(session, 'question');
    expect(question.message).toBe('Pick a color');
    expect(question.fields[0]?.type).toBe('single');
    expect(question.fields[0]?.otherFieldId).toBeDefined();
    // Real users answer after the turn has parked waiting for them.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    session.answerQuestion(question.id, 'accept', {
      [question.fields[0]?.id ?? '']: question.fields[0]?.options[1]?.value ?? '',
    });
    await turn;
    await waitFor(() => session.model.lastAssistantText()?.includes('Thanks for answering') === true);
    await waitFor(() => session.meta.status === 'idle');
  }, 30_000);

  it('steers a running turn and queues the next prompt with visible output', async () => {
    const turn = send('DO_SLOW please');
    await waitFor(() => session.model.items.at(-1)?.kind === 'assistant');
    await session.submit({ text: 'steering note', attachments: [] });
    await session.submit({ text: 'queued follow-up', attachments: [] }, { alternate: true });
    expect(session.meta.queue.map((item) => item.text)).toEqual(['queued follow-up']);
    expect(
      session.model.items.some((item) => item.kind === 'user' && item.steered === true),
    ).toBe(true);
    await turn;
    await waitFor(
      () =>
        session.model.items.some(
          (item) =>
            item.kind === 'user' && item.content.some((c) => c.type === 'text' && c.text === 'queued follow-up'),
        ) && session.meta.status === 'idle',
    );
    expect(session.meta.queue).toEqual([]);
    expect(fixture.requests.some((request) => request.includes('queued follow-up'))).toBe(true);
    expect(fixture.requests.some((request) => request.includes('steering note'))).toBe(true);
  }, 30_000);

  it('cancels a running turn', async () => {
    const turn = send('DO_SLOW again');
    await waitFor(() => session.model.items.at(-1)?.kind === 'assistant');
    await session.cancel();
    await turn;
    expect(session.meta.status).toBe('idle');
    expect(session.model.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped.' });
  }, 30_000);

  it('switches mode through the next prompt', async () => {
    await session.setMode('plan');
    expect(session.meta.pendingModeId).toBe('plan');
    await send('plan something');
    await waitFor(() => session.meta.currentModeId === 'plan');
    expect(session.meta.pendingModeId).toBeUndefined();
    await session.setMode('default');
    await send('back to work');
    await waitFor(() => session.meta.currentModeId === 'default');
  }, 30_000);

  it('manages a Goal', async () => {
    expect(session.meta.goalsEnabled).toBe(true);
    await session.goalCreate('Finish the fixture work', 50_000);
    expect(session.meta.goal).toMatchObject({ objective: 'Finish the fixture work', tokenBudget: 50_000 });
    await session.goalPatch({ status: 'paused' });
    expect(session.meta.goal?.status).toBe('paused');
    await session.goalClear();
    expect(session.meta.goal).toBeNull();
    await waitFor(() => session.meta.status === 'idle', 15_000);
  }, 30_000);

  it('lists sessions, replays history and forks', async () => {
    const listed = await manager.listSessions(fixture.workspace);
    expect(listed.map((entry) => entry.sessionId)).toContain(session.id);

    const fork = await manager.forkSession(session.id, { side: true });
    expect(fork.id).not.toBe(session.id);
    expect(fork.meta.isSide).toBe(true);
    const userText = fork.model.items
      .filter((item) => item.kind === 'user')
      .flatMap((item) => item.content)
      .map((content) => (content.type === 'text' ? content.text : ''));
    expect(userText.join('\n')).toContain('hello there');
    expect(userText.join('\n')).not.toContain('<system-reminder>');
    expect(fork.model.items.some((item) => item.kind === 'tool')).toBe(true);
    await manager.closeSession(fork.id);
    expect(manager.sessions.has(fork.id)).toBe(false);
    manager.setActive(session.id);
  }, 30_000);

  it('talks to the provider and plugin CLIs', async () => {
    const list = await providers.list(cliContext);
    expect(list.providers.map((provider) => provider.providerId)).toContain('custom_provider:fixture');
    const installed = await plugins.list(cliContext);
    expect(installed.installed).toEqual([]);
    expect((await plugins.marketplaces(cliContext)).map((source) => source.name)).toContain('local');
  }, 60_000);

  it('recovers from an agent crash and reattaches open sessions', async () => {
    const before = session.model.items.length;
    const agent = (manager as unknown as { agent: { child: { kill(signal: string): void } } }).agent;
    agent.child.kill('SIGKILL');
    await waitFor(() => session.meta.status === 'detached', 5_000);
    await waitFor(() => session.meta.status === 'idle' && manager.connection.state === 'connected', 30_000);
    expect(session.model.items.length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    await send('still alive?');
    expect(session.model.lastAssistantText()).toContain('Echo');
  }, 60_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${condition.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForItem<T>(session: SessionController, kind: string): Promise<T> {
  let found: T | undefined;
  await waitFor(() => {
    const item = session.model.items.filter((candidate) => candidate.kind === kind).at(-1);
    if (item && !('resolution' in item && item.resolution !== undefined)) found = item as T;
    return found !== undefined;
  }, 15_000);
  return found as T;
}
