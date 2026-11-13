import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AlranAgent } from '../../src/acp/agent';
import { resolveAlranCli } from '../../src/acp/binary';
import { account, startLogin, modelKeyFromConfigValue } from '../../src/core/account';
import type { CliContext } from '../../src/core/cli';
import { SessionManager } from '../../src/core/manager';
import type { SessionController } from '../../src/core/session';
import { createFixture, findCli, type Fixture } from '../fixtures/fakeModel';
import { createFakeOttili, type FakeOttili } from '../fixtures/fakeOttili';

/** Model calls through the Ottili AI Gateway with a Platform session, as a signed-in person makes them. */
describe.skipIf(!findCli())('Ottili models through the Gateway', () => {
  let fixture: Fixture;
  let ottili: FakeOttili;
  let context: CliContext;
  let manager: SessionManager;
  let session: SessionController;

  const choose = (key: string, variant = '') => {
    const option = session.meta.config.find((entry) => entry.id === 'model');
    const choice = option?.options.find(
      (entry) => modelKeyFromConfigValue(entry.value) === key && entry.value.endsWith(`:v:${variant}`),
    );
    if (!choice) throw new Error(`No model ${key} in ${JSON.stringify(option?.options)}`);
    return session.setConfigOption('model', choice.value);
  };

  beforeAll(async () => {
    fixture = await createFixture();
    ottili = await createFakeOttili({ upstream: fixture.modelOrigin });
    const env = { ...fixture.env, ...ottili.env };
    context = { cli: await resolveAlranCli({ configuredPath: fixture.cliPath, env }), cwd: fixture.workspace, env };
    const handle = startLogin(context, { flow: 'device' }, { onDeviceCode: () => ottili.approveDevice() });
    await handle.done;
    await account.setProject(context, 'prj-web');
    const noop = () => undefined;
    manager = new SessionManager(
      {
        createAgent: (handlers) => Promise.resolve(new AlranAgent({ cli: context.cli, cwd: fixture.workspace, env }, handlers)),
        mcpServers: () => [],
        enterWhileRunning: () => 'steer',
      },
      { connection: noop, tabs: noop, items: noop, meta: noop, snapshot: noop, changes: noop, attention: noop, turn: noop, log: noop },
    );
    session = await manager.newSession(fixture.workspace);
  }, 60_000);

  afterAll(async () => {
    await manager?.dispose();
    await ottili?.close();
    await fixture?.cleanup();
  });

  it('runs Ottili Werk with the session, company and project', async () => {
    await choose('alran/Alran-Werk');
    await session.submit({ text: 'hello through the gateway', attachments: [] });
    expect(session.model.lastAssistantText()).toContain('Echo');
    expect(ottili.completions.at(-1)).toEqual({ model: 'ottili/werk-1.1', company: 'cmp-acme', project: 'prj-web' });
  }, 60_000);

  it('explains that Claude needs purchased credit', async () => {
    await choose('alran/anthropic/claude-sonnet-5.5', 'thinking');
    await session.submit({ text: 'review this with Claude', attachments: [] });
    const notice = session.model.items.findLast((item) => item.kind === 'notice');
    expect(notice?.kind === 'notice' && notice.failure).toMatchObject({
      kind: 'model-restricted',
      actions: ['use-werk', 'add-credits'],
    });
    expect(ottili.completions.at(-1)?.model).toBe('anthropic/claude-sonnet-5.5');
  }, 90_000);
});
