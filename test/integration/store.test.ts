import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveAlranCli } from '../../src/acp/binary';
import { AlranCliError, type CliContext } from '../../src/core/cli';
import { store, type StoreItem } from '../../src/core/store';
import { createFixture, findCli, STORE_FIXTURE, type Fixture } from '../fixtures/fakeModel';

/** The Plugin Store and Skill Library, driven through the real CLI against a small offline store. */
describe.skipIf(!findCli())('Plugin Store and Skill Library', () => {
  let fixture: Fixture;
  let context: CliContext;

  const plugin = async (name: string): Promise<StoreItem> => {
    const found = (await store.plugins(context)).items.find((entry) => entry.name === name);
    if (!found) throw new Error(`The test store does not offer ${name}`);
    return found;
  };
  const skill = async (name: string): Promise<StoreItem> => {
    const found = (await store.library(context)).items.find((entry) => entry.name === name);
    if (!found) throw new Error(`The test store does not offer ${name}`);
    return found;
  };

  beforeAll(async () => {
    fixture = await createFixture();
    context = {
      cli: await resolveAlranCli({ configuredPath: fixture.cliPath, env: fixture.env }),
      cwd: fixture.workspace,
      env: fixture.env,
    };
  }, 60_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it('lists the Plugins a store offers', async () => {
    const listing = await store.plugins(context);
    expect(listing.items.map((entry) => entry.name).sort()).toEqual(['demo-skills', 'hook-demo']);
    expect(listing.notes).toEqual([]);
    expect(await plugin('demo-skills')).toMatchObject({
      kind: 'plugin',
      origin: 'ottili',
      displayName: 'Demo Skills',
      installed: false,
      summary: '3 skills',
    });
  });

  it('lists the Skill Library with the built-in Skills in their own group', async () => {
    const { items } = await store.library(context);
    expect(items.filter((entry) => entry.group === 'Demo skills').map((entry) => entry.name).sort()).toEqual([
      'changelog-check',
      'code-tour',
      'release-notes',
    ]);
    const builtIn = items.filter((entry) => entry.origin === 'built-in');
    expect(builtIn.length).toBeGreaterThan(0);
    expect(builtIn.every((entry) => entry.installed && entry.group === 'Built in')).toBe(true);
  });

  it('shows what a Plugin contains before it is installed', async () => {
    const text = await store.info(context, await plugin('demo-skills'));
    expect(text).toContain('Demo Skills');
    expect(text).toContain('3 skills');
  });

  it('installs a Plugin that only holds Skills without asking', async () => {
    const outcome = await store.install(context, await plugin('demo-skills'));
    expect(outcome.status).toBe('done');
    const installed = await store.installed(context);
    expect(installed.items.find((entry) => entry.name === 'demo-skills')).toMatchObject({
      kind: 'plugin',
      installed: true,
      enabled: true,
      origin: 'ottili',
    });
  });

  it('asks before installing a Plugin that runs commands, and installs it once approved', async () => {
    const item = await plugin('hook-demo');
    const first = await store.install(context, item);
    expect(first.status).toBe('needs-approval');
    if (first.status !== 'needs-approval') return;
    expect(first.commands).toHaveLength(1);
    expect(first.commands[0]).toContain('SessionStart');
    expect(first.commands[0]).toContain('session-start');
    // Nothing was written by the refusal.
    expect((await store.installed(context)).items.some((entry) => entry.name === 'hook-demo')).toBe(false);

    expect((await store.install(context, item, true)).status).toBe('done');
    expect((await store.installed(context)).items.find((entry) => entry.name === 'hook-demo')).toMatchObject({ installed: true });
  });

  it('switches an installed Plugin off and on', async () => {
    const item = (await store.installed(context)).items.find((entry) => entry.name === 'demo-skills')!;
    await store.setEnabled(context, item, false);
    expect((await store.installed(context)).items.find((entry) => entry.name === 'demo-skills')?.enabled).toBe(false);
    await store.setEnabled(context, item, true);
    expect((await store.installed(context)).items.find((entry) => entry.name === 'demo-skills')?.enabled).toBe(true);
  });

  it('removes Plugins again', async () => {
    for (const name of ['demo-skills', 'hook-demo']) {
      const item = (await store.installed(context)).items.find((entry) => entry.name === name)!;
      await store.remove(context, item);
    }
    expect((await store.installed(context)).items.filter((entry) => entry.kind === 'plugin')).toEqual([]);
  });

  it('installs and removes a single Skill from the library', async () => {
    const item = await skill('code-tour');
    expect((await store.install(context, item)).status).toBe('done');
    expect((await skill('code-tour')).installed).toBe(true);
    expect((await store.installed(context)).items.some((entry) => entry.kind === 'skill' && entry.name === 'code-tour')).toBe(true);
    await store.remove(context, await skill('code-tour'));
    expect((await skill('code-tour')).installed).toBe(false);
  });

  it('adds and removes a store, and names the stores it reads', async () => {
    const before = await store.sources(context);
    expect(before.map((entry) => entry.name)).toEqual(['ottili', 'local']);
    await store.addSource(context, STORE_FIXTURE, 'second');
    expect((await store.sources(context)).some((entry) => entry.name === 'second' && !entry.builtin)).toBe(true);
    await store.removeSource(context, 'second');
    expect((await store.sources(context)).map((entry) => entry.name)).toEqual(['ottili', 'local']);
  });

  it('reports a store it cannot read instead of failing', async () => {
    const offline: CliContext = { ...context, env: { ...context.env, ALRAN_STORE_URL: 'http://127.0.0.1:9/index.json' } };
    const listing = await store.plugins(offline);
    expect(listing.items).toEqual([]);
    expect(listing.notes.join(' ')).toMatch(/could not be (read|reached)/u);
  });

  it('turns a refusal that is not an approval request into an error', async () => {
    await expect(store.install(context, { ...(await plugin('hook-demo')), name: 'does-not-exist' })).rejects.toBeInstanceOf(AlranCliError);
  });
});
