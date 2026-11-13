import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveAlranCli } from '../../src/acp/binary';
import { account, credentialOf, startLogin, type DeviceCode } from '../../src/core/account';
import { AlranCliError, providers, type CliContext } from '../../src/core/cli';

import { createFixture, findCli, type Fixture } from '../fixtures/fakeModel';
import { completeBrowserSignIn, createFakeOttili, type FakeOttili } from '../fixtures/fakeOttili';

/** The account commands of the real CLI against a scripted Ottili Platform and Gateway. */
describe.skipIf(!findCli())('Ottili account through the real CLI', () => {
  let fixture: Fixture;
  let ottili: FakeOttili;
  let context: CliContext;

  beforeAll(async () => {
    fixture = await createFixture();
    ottili = await createFakeOttili();
    const env = { ...fixture.env, ...ottili.env };
    context = { cli: await resolveAlranCli({ configuredPath: fixture.cliPath, env }), cwd: fixture.workspace, env };
  }, 30_000);

  afterAll(async () => {
    await ottili?.close();
    await fixture?.cleanup();
  });

  it('describes a bring-your-own-key setup before any sign-in', async () => {
    const list = await providers.list(context);
    expect(credentialOf({ signedIn: false }, list)).toEqual({ kind: 'provider', name: 'fixture' });
  });

  it('reports a signed-out account as a normal answer', async () => {
    expect(await account.status(context)).toEqual({ signedIn: false });
    await expect(account.usage(context)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('lists the models with prices while signed out', async () => {
    const models = await account.models(context);
    expect(models.map((model) => model.short)).toEqual(['werk', 'sonnet', 'opus']);
    expect(models[0]).toMatchObject({ name: 'Ottili Werk 1.1', input: 500_000, status: 'sign in to check' });
  });

  it('signs in through the browser flow', async () => {
    let url = '';
    const handle = startLogin(context, { flow: 'browser' }, { onBrowserUrl: (value) => (url = value) });
    for (let waited = 0; !url && waited < 20_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(url).toContain(`${ottili.origin}/v2/auth/oidc/login?return_to=`);
    expect(await completeBrowserSignIn(url)).toBeLessThan(400);
    const outcome = await handle.done;
    expect(outcome.alreadySignedIn).toBe(false);
    expect(await account.status(context)).toMatchObject({
      signedIn: true,
      name: 'Alex Morgan',
      companyId: 'cmp-acme',
      projectId: null,
    });
  }, 40_000);

  it('reads credit, spending and model availability', async () => {
    const credits = await account.usage(context);
    expect(credits.available_microcents).toBe(4_800_000);
    expect(credits.current_month?.by_model?.[0]?.model).toBe('ottili/werk-1.1');
    const models = await account.models(context);
    expect(models.find((model) => model.short === 'werk')?.status).toBe('available');
    expect(models.find((model) => model.short === 'sonnet')?.status).toBe('requires purchased credit');
  });

  it('switches company and project', async () => {
    const { current, companies } = await account.companies(context);
    expect(current).toBe('cmp-acme');
    expect(companies.map((company) => company.slug)).toEqual(['acme', 'globex']);
    await account.switchCompany(context, 'globex');
    expect((await account.status(context)).companyId).toBe('cmp-globex');
    const { projects } = await account.projects(context);
    expect(projects.map((project) => project.name)).toEqual(['Website', 'API']);
    await account.setProject(context, 'prj-api');
    expect((await account.status(context)).projectId).toBe('prj-api');
    await account.clearProject(context);
    expect((await account.status(context)).projectId).toBeNull();
  });

  it('sets the default model and reads billing', async () => {
    await account.setDefaultModel(context, 'sonnet');
    expect((await account.status(context)).defaultModel).toBe('alran/anthropic/claude-sonnet-5.5');
    await account.setDefaultModel(context, 'werk');
    const billing = await account.billing(context);
    expect(billing.payment_methods[0]?.label).toBe('Visa •••• 4242');
    expect(billing.manage_at).toBe(`${ottili.origin}/billing`);
  });

  it('says so when a session already exists', async () => {
    const outcome = await startLogin(context, { flow: 'browser' }, {}).done;
    expect(outcome.alreadySignedIn).toBe(true);
  });

  it('signs out and revokes the session at the Platform', async () => {
    const session = ottili.state.session;
    await account.logout(context);
    expect(ottili.state.revoked).toContain(session);
    expect(await account.status(context)).toEqual({ signedIn: false });
  });

  it('signs in with a device code', async () => {
    const codes: DeviceCode[] = [];
    const handle = startLogin(context, { flow: 'device' }, { onDeviceCode: (code) => codes.push(code) });
    for (let waited = 0; codes.length === 0 && waited < 20_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(codes[0]).toMatchObject({ userCode: 'BCDF-GHJK', verificationUri: `${ottili.origin}/device` });
    ottili.approveDevice();
    await handle.done;
    expect((await account.status(context)).signedIn).toBe(true);
    await account.logout(context);
  }, 40_000);

  it('cancels a pending device sign-in', async () => {
    let shown = false;
    const handle = startLogin(context, { flow: 'device' }, { onDeviceCode: () => (shown = true) });
    for (let waited = 0; !shown && waited < 20_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    handle.cancel();
    await expect(handle.done).rejects.toMatchObject({ name: 'LoginCancelledError' });
    expect((await account.status(context)).signedIn).toBe(false);
  }, 40_000);

  it('turns an unreachable Platform into an offline error', async () => {
    const offline = { ...context, env: { ...context.env, OTTILI_PLATFORM_URL: 'http://127.0.0.1:9', ALRAN_API_BASE: 'http://127.0.0.1:9/v1' } };
    const handle = startLogin(offline, { flow: 'device' }, {});
    const error = await handle.done.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AlranCliError);
    expect((error as Error).message).toMatch(/reach|connect/iu);
  }, 40_000);

});
