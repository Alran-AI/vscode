import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as vscode from 'vscode';

import { errorMessage } from '../acp/agent';
import { AlranCliNotFoundError } from '../acp/binary';
import {
  account,
  formatMicroUsd,
  formatModelPrice,
  LoginCancelledError,
  credentialOf,
  type AccountStatus,
  type Billing,
  type Credential,
  type Credits,
  type DeviceCode,
  type OttiliModel,
  startLogin,
} from '../core/account';
import { AlranCliError, providers } from '../core/cli';
import type { AccountView } from '../shared/types';
import type { AlranRuntime } from './runtime';

export const AUTH_PROVIDER_ID = 'alran';
const AUTH_PROVIDER_LABEL = 'Ottili';
const DEFAULT_BILLING_URL = 'https://ai.ottili.one/billing';
const API_KEYS_URL = 'https://ai.ottili.one/api-keys';
const USAGE_REFRESH_MS = 60_000;

export interface AccountSnapshot {
  /** Undefined until the first status check finished. */
  readonly status?: AccountStatus;
  /** How model calls authenticate (session, Ottili API key, own provider). */
  readonly credential?: Credential;
  readonly credits?: Credits;
  readonly models?: readonly OttiliModel[];
  /** Why the last refresh failed (offline, CLI missing, …). */
  readonly error?: string;
  readonly loading: boolean;
  /** The CLI on this machine predates the account commands. */
  readonly unsupported?: boolean;
  /** A newer CLI release, from the CLI's own weekly check. */
  readonly latestVersion?: string;
  /** The readable name (slug) of the current company. */
  readonly companyName?: string;
  readonly billing?: Billing;
}

type SignInFlow = 'browser' | 'device';

/** The Ottili account: sign-in, company, project, models, credits, billing. */
export class AccountService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<AccountSnapshot>();
  readonly onDidChange = this.changeEmitter.event;
  private current: AccountSnapshot = { loading: false };
  private refreshing: Promise<void> | undefined;
  private usageCheckedAt = 0;
  private signingIn: Promise<boolean> | undefined;
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  /** Restarts the agent so it picks up new credentials. */
  onCredentialsChanged: () => Promise<void> = () => Promise.resolve();

  constructor(private readonly runtime: AlranRuntime) {
    this.disposables.push(
      runtime.onDidChangeTurn(({ running }) => {
        // Spending changes with every finished turn; refresh it at most once a minute.
        if (!running && this.current.status?.signedIn && Date.now() - this.usageCheckedAt > USAGE_REFRESH_MS) {
          void this.refresh({ usage: true });
        }
      }),
    );
  }

  get snapshot(): AccountSnapshot {
    return this.current;
  }

  get signedIn(): boolean {
    return this.current.status?.signedIn === true;
  }

  /** The compact form the chat webview shows. */
  get view(): AccountView {
    const { status, credits, credential } = this.current;
    if (!status) return { state: this.current.loading ? 'loading' : 'unknown' };
    if (!status.signedIn) {
      if (credential?.kind === 'api-key') return { state: 'api-key', ...(credential.masked ? { label: credential.masked } : {}) };
      if (credential?.kind === 'provider') return { state: 'provider', label: credential.name };
      return { state: 'signed-out' };
    }
    return {
      state: 'signed-in',
      name: status.name ?? 'Ottili account',
      ...(this.current.companyName || status.companyId ? { company: this.current.companyName ?? status.companyId } : {}),
      ...(credits?.available_microcents !== undefined
        ? {
            credit: formatMicroUsd(credits.available_microcents),
            lowCredit: credits.available_microcents < 500_000,
          }
        : {}),
    };
  }

  private update(patch: Partial<AccountSnapshot>): void {
    this.current = { ...this.current, ...patch };
    this.changeEmitter.fire(this.current);
  }

  /** Re-reads the account. Usage and models cost Gateway calls, so they are opt-in. */
  refresh(options: { readonly usage?: boolean } = {}): Promise<void> {
    this.refreshing ??= this.doRefresh(options).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(options: { readonly usage?: boolean }): Promise<void> {
    this.update({ loading: true });
    try {
      const context = await this.runtime.cliContext();
      const [status, list] = await Promise.all([
        account.status(context),
        providers.list(context).catch(() => undefined),
      ]);
      const latestVersion = await this.readLatestVersion();
      this.update({
        status,
        credential: credentialOf(status, list),
        unsupported: false,
        ...(latestVersion ? { latestVersion } : {}),
        ...(status.signedIn ? {} : { credits: undefined }),
      });
      if (status.signedIn && (options.usage || !this.current.credits)) {
        this.usageCheckedAt = Date.now();
        const [credits, models, companies, billing] = await Promise.all([
          account.usage(context).catch(() => undefined),
          account.models(context).catch(() => undefined),
          account.companies(context).catch(() => undefined),
          account.billing(context).catch(() => undefined),
        ]);
        const company = companies?.companies.find((entry) => entry.company_id === status.companyId);
        this.update({
          ...(credits ? { credits } : {}),
          ...(models ? { models } : {}),
          ...(company?.slug ? { companyName: company.slug } : {}),
          ...(billing ? { billing } : {}),
        });
      } else if (!status.signedIn && !this.current.models) {
        const models = await account.models(context).catch(() => undefined);
        if (models) this.update({ models });
      }
      this.update({ error: undefined });
    } catch (error) {
      const unsupported =
        error instanceof AlranCliError && /unknown command|printed no JSON/iu.test(error.message);
      this.update({
        error: error instanceof AlranCliNotFoundError ? 'The Alran CLI is not installed.' : errorMessage(error),
        unsupported,
      });
      this.runtime.output.warn(`account: ${errorMessage(error)}`);
    } finally {
      this.update({ loading: false });
    }
  }

  /** The CLI records the newest release it saw in its data directory. */
  private async readLatestVersion(): Promise<string | undefined> {
    try {
      const raw = await readFile(path.join(this.runtime.dataDir(), 'update-check.json'), 'utf8');
      const parsed = JSON.parse(raw) as { latestVersion?: unknown };
      return typeof parsed.latestVersion === 'string' ? parsed.latestVersion : undefined;
    } catch {
      return undefined;
    }
  }

  // Sign-in ---------------------------------------------------------------------------------------------

  /** The flow that can reach the person's browser from this window. */
  defaultFlow(): SignInFlow {
    // A remote or web window cannot receive the loopback callback on 127.0.0.1.
    if (vscode.env.remoteName || vscode.env.uiKind === vscode.UIKind.Web) return 'device';
    return 'browser';
  }

  /** Signs in with the Ottili account. Resolves true when signed in afterwards. */
  signIn(options: { readonly flow?: SignInFlow; readonly force?: boolean } = {}): Promise<boolean> {
    this.signingIn ??= this.doSignIn(options).finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async doSignIn(options: { readonly flow?: SignInFlow; readonly force?: boolean }): Promise<boolean> {
    const flow = options.flow ?? this.defaultFlow();
    const context = await this.runtime.cliContext();
    this.runtime.output.info(`sign-in: starting the ${flow} flow`);
    try {
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Signing in to Ottili',
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: 'Starting…' });
          const handle = startLogin(context, { flow, ...(options.force ? { force: true } : {}) }, {
            onBrowserUrl: (url) => {
              progress.report({ message: 'Finish signing in in your browser.' });
              void openExternalUrl(url);
            },
            onDeviceCode: (code) => {
              progress.report({ message: `Confirm the code ${code.userCode} in your browser.` });
              // The page opens with the code filled in; the person only confirms it.
              void openExternalUrl(code.verificationUriComplete ?? code.verificationUri).then((opened) => {
                if (!opened) void this.offerDeviceCode(code);
              });
            },
          });
          token.onCancellationRequested(() => handle.cancel());
          return handle.done;
        },
      );
      this.runtime.output.info(`sign-in: ${outcome.message}`);
      await this.refresh({ usage: true });
      if (!this.signedIn) return false;
      void vscode.window.showInformationMessage(
        `Signed in to Ottili as ${this.current.status?.name ?? 'your account'}.`,
      );
      await this.onCredentialsChanged();
      return true;
    } catch (error) {
      if (error instanceof LoginCancelledError) return false;
      await this.reportSignInFailure(error, flow);
      return false;
    }
  }

  private async offerDeviceCode(code: DeviceCode): Promise<void> {
    const open = 'Copy Code and Open Browser';
    const choice = await vscode.window.showInformationMessage(
      `Your Ottili sign-in code is ${code.userCode}. Confirm it at ${code.verificationUri}.`,
      open,
    );
    if (choice === open) {
      await vscode.env.clipboard.writeText(code.userCode);
      await openExternalUrl(code.verificationUriComplete ?? code.verificationUri);
    }
  }

  private async reportSignInFailure(error: unknown, flow: SignInFlow): Promise<void> {
    const message = errorMessage(error);
    this.runtime.output.error(`sign-in failed: ${message}`);
    if (error instanceof AlranCliNotFoundError) {
      await vscode.commands.executeCommand('alran.installCli');
      return;
    }
    const portBusy = /already in use|EADDRINUSE/iu.test(message);
    const alternative = flow === 'browser' ? 'Sign In with a Code' : 'Sign In with the Browser';
    const choice = await vscode.window.showErrorMessage(
      portBusy
        ? 'Another sign-in is still waiting in a browser or terminal. Close it, or sign in with a code instead.'
        : `Sign-in did not complete: ${message}`,
      alternative,
      'Use an API Key',
      'Show Logs',
    );
    if (choice === alternative) await this.signIn({ flow: flow === 'browser' ? 'device' : 'browser' });
    else if (choice === 'Use an API Key') await this.signInWithApiKey();
    else if (choice === 'Show Logs') this.runtime.output.show();
  }

  /** Every way to connect a model, for the "Sign in…" picker. */
  async signInOptions(): Promise<void> {
    const recommended = this.defaultFlow();
    type Choice = vscode.QuickPickItem & { readonly id: 'browser' | 'device' | 'api-key' | 'provider' };
    const items: Choice[] = [
      {
        id: 'browser',
        label: '$(globe) Sign in with your browser',
        description: recommended === 'browser' ? 'Recommended' : '',
        detail: 'Opens the Ottili sign-in page on this computer.',
      },
      {
        id: 'device',
        label: '$(device-mobile) Sign in with a code',
        description: recommended === 'device' ? 'Recommended for remote windows' : '',
        detail: 'Shows a code you confirm in a browser on any device.',
      },
      {
        id: 'api-key',
        label: '$(key) Use an Ottili API key',
        detail: `Paste a key created at ${API_KEYS_URL}.`,
      },
      {
        id: 'provider',
        label: '$(server) Use your own model provider',
        detail: 'Bring your own API key (OpenAI-compatible or Anthropic). No Ottili account needed.',
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Connect Alran Code',
      placeHolder: 'How do you want to connect a model?',
    });
    if (!picked) return;
    if (picked.id === 'api-key') await this.signInWithApiKey();
    else if (picked.id === 'provider') await vscode.commands.executeCommand('alran.providerAdd');
    else await this.signIn({ flow: picked.id, force: this.signedIn });
  }

  async signInWithApiKey(): Promise<boolean> {
    const openPage = 'Open API Keys Page';
    const apiKey = await vscode.window.showInputBox({
      title: 'Ottili API key',
      prompt: `Paste an Ottili API key (sk-ottili-…). Create one at ${API_KEYS_URL}.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim() || value.trim().startsWith('sk-ottili-')
          ? undefined
          : 'Ottili API keys start with sk-ottili-.',
    });
    if (apiKey === undefined) return false;
    if (!apiKey.trim()) {
      const choice = await vscode.window.showInformationMessage('Create an API key first.', openPage);
      if (choice === openPage) await openExternalUrl(API_KEYS_URL);
      return false;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Saving your Ottili API key…' },
        async () => account.loginWithApiKey(await this.runtime.cliContext(), apiKey.trim()),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`The API key was not saved: ${errorMessage(error)}`);
      return false;
    }
    void vscode.window.showInformationMessage('Alran Code uses your Ottili API key now.');
    await this.refresh({ usage: true });
    await this.onCredentialsChanged();
    return true;
  }

  async signOut(options: { readonly confirm?: boolean } = {}): Promise<boolean> {
    if (options.confirm !== false) {
      const confirm = 'Sign Out';
      const choice = await vscode.window.showWarningMessage(
        `Sign out of Ottili${this.current.status?.name ? ` (${this.current.status.name})` : ''}?`,
        {
          modal: true,
          detail: 'The session is revoked at the Ottili Platform and removed from this computer. Running tasks stop.',
        },
        confirm,
      );
      if (choice !== confirm) return false;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Signing out of Ottili…' },
        async () => account.logout(await this.runtime.cliContext()),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Sign-out failed: ${errorMessage(error)}`);
      return false;
    }
    this.update({ credits: undefined });
    await this.refresh();
    await this.onCredentialsChanged();
    void vscode.window.showInformationMessage('Signed out of Ottili.');
    return true;
  }

  // Company, project, model -----------------------------------------------------------------------------

  private async requireSignIn(): Promise<boolean> {
    if (!this.current.status) await this.refresh();
    if (this.signedIn) return true;
    const signIn = 'Sign In';
    const choice = await vscode.window.showInformationMessage('Sign in to your Ottili account first.', signIn);
    return choice === signIn ? this.signIn() : false;
  }

  async switchCompany(): Promise<void> {
    if (!(await this.requireSignIn())) return;
    const context = await this.runtime.cliContext();
    const { current, companies } = await withBusy('Loading your companies…', () => account.companies(context));
    if (companies.length === 0) {
      void vscode.window.showInformationMessage(
        'Your account is not a member of a company yet. Create or join one in the Ottili Console.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      companies.map((company) => ({
        label: `${company.company_id === current ? '$(check) ' : ''}${company.slug ?? company.company_id}`,
        description: (company.roles ?? []).join(', '),
        detail: company.slug ? company.company_id : undefined,
        company,
      })),
      { title: 'Switch company', placeHolder: 'Model calls, usage and billing use the chosen company' },
    );
    if (!picked || picked.company.company_id === current) return;
    await withBusy('Switching company…', () => account.switchCompany(context, picked.company.company_id));
    this.update({ companyName: picked.company.slug });
    await this.refresh({ usage: true });
    void vscode.window.showInformationMessage(`Alran Code works in ${picked.company.slug ?? picked.company.company_id} now.`);
  }

  async selectProject(): Promise<void> {
    if (!(await this.requireSignIn())) return;
    const context = await this.runtime.cliContext();
    const { current, projects } = await withBusy('Loading your projects…', () => account.projects(context));
    const items = [
      {
        label: `${current ? '' : '$(check) '}Default project of the company`,
        description: '',
        id: '' as string,
      },
      ...projects.map((project) => ({
        label: `${project.project_id === current ? '$(check) ' : ''}${project.name ?? project.project_id}`,
        description: project.access?.role ?? '',
        id: project.project_id,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Choose project',
      placeHolder: 'Model calls are attributed to this project',
    });
    if (!picked || picked.id === (current ?? '')) return;
    await withBusy('Saving project…', () =>
      picked.id ? account.setProject(context, picked.id) : account.clearProject(context),
    );
    await this.refresh();
  }

  /** Makes a model the default for new sessions (`alran config model`). */
  async setDefaultModel(model: OttiliModel): Promise<void> {
    await account.setDefaultModel(await this.runtime.cliContext(), model.short);
    await this.refresh();
    void vscode.window.showInformationMessage(`${model.name} is the default model for new sessions.`);
  }

  async pickDefaultModel(): Promise<void> {
    if (!this.current.models) await this.refresh({ usage: true });
    const models = this.current.models ?? [];
    if (models.length === 0) {
      void vscode.window.showWarningMessage(this.current.error ?? 'The Ottili models could not be listed.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: `${model.default ? '$(check) ' : ''}${model.name}`,
        description: formatModelPrice(model),
        detail: `${model.description} · ${availabilityLabel(model)}`,
        model,
      })),
      { title: 'Default model for new sessions', matchOnDetail: true },
    );
    if (picked && !picked.model.default) await this.setDefaultModel(picked.model);
  }

  async openBilling(): Promise<void> {
    let url = this.current.billing?.manage_at || DEFAULT_BILLING_URL;
    if (this.signedIn && !this.current.billing) {
      try {
        url = (await account.billing(await this.runtime.cliContext())).manage_at || url;
      } catch {
        // The public billing page works for every account.
      }
    }
    await openExternalUrl(url);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export function availabilityLabel(model: Pick<OttiliModel, 'status'>): string {
  switch (model.status) {
    case 'available':
      return 'Covered by your credit';
    case 'requires purchased credit':
      return 'Needs purchased credit';
    case 'no credit left':
      return 'No credit left';
    case 'sign in to check':
      return 'Sign in to check availability';
    default:
      return model.status;
  }
}

async function withBusy<T>(title: string, run: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, run);
}

let testHooksEnabled = false;

/** Test hooks (an environment variable that redirects the browser to a file) work only in the extension test host. */
export function enableTestHooks(enabled: boolean): void {
  testHooksEnabled = enabled;
}

/**
 * Opens a URL exactly as given. `Uri.parse` re-encodes query strings (the
 * sign-in URL carries an encoded `return_to`), so the string form is passed,
 * which the extension host accepts and validates.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const testLog = testHooksEnabled ? process.env.ALRAN_TEST_OPEN_EXTERNAL_LOG : undefined;
  if (testLog) {
    // End-to-end tests record the URL instead of launching a browser.
    await appendFile(testLog, `${url}\n`);
    return true;
  }
  return vscode.env.openExternal(url as unknown as vscode.Uri);
}

/** Shows the Ottili account in the editor's Accounts menu. */
export class OttiliAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly sessionsEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.sessionsEmitter.event;
  private lastSession: vscode.AuthenticationSession | undefined;
  private readonly listener: vscode.Disposable;

  constructor(private readonly service: AccountService) {
    this.listener = service.onDidChange(() => this.sync());
  }

  /** The session as other extensions see it: who, never the credential. */
  private toSession(): vscode.AuthenticationSession | undefined {
    const status = this.service.snapshot.status;
    if (!status?.signedIn) return undefined;
    const id = status.subjectId ?? status.name ?? 'ottili';
    return {
      id,
      // The Platform session is a bearer credential for the Gateway; it stays with the CLI.
      accessToken: '',
      account: { id, label: status.name ?? 'Ottili account' },
      scopes: [],
    };
  }

  private sync(): void {
    if (this.service.snapshot.loading) return;
    const next = this.toSession();
    const previous = this.lastSession;
    if (previous?.id === next?.id && previous?.account.label === next?.account.label) return;
    this.lastSession = next;
    this.sessionsEmitter.fire({
      added: next && !previous ? [next] : [],
      removed: previous && !next ? [previous] : [],
      changed: previous && next ? [next] : [],
    });
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    if (!this.service.snapshot.status) await this.service.refresh();
    const session = this.toSession();
    this.lastSession = session;
    return session ? [session] : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    if (!(await this.service.signIn())) throw new Error('Sign-in was not completed.');
    const session = this.toSession();
    if (!session) throw new Error('Sign-in was not completed.');
    return session;
  }

  async removeSession(): Promise<void> {
    await this.service.signOut({ confirm: false });
  }

  dispose(): void {
    this.listener.dispose();
    this.sessionsEmitter.dispose();
  }
}

export function registerAuthenticationProvider(service: AccountService): {
  readonly provider: OttiliAuthenticationProvider;
  readonly disposable: vscode.Disposable;
} {
  const provider = new OttiliAuthenticationProvider(service);
  return {
    provider,
    disposable: vscode.Disposable.from(
      provider,
      vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, AUTH_PROVIDER_LABEL, provider, {
        supportsMultipleAccounts: false,
      }),
    ),
  };
}
