import path from 'node:path';

import * as vscode from 'vscode';

import { formatMicroUsd, formatModelPrice } from '../core/account';
import * as cli from '../core/cli';
import type { FileChange } from '../core/changes';
import type { PersistedSessionInfo } from '../core/manager';
import type { DelegationMemberView, MentionCandidate, SessionStatus } from '../shared/types';
import { availabilityLabel, type AccountService } from './account';
import { parseMcpList } from './parseMcp';
import type { AlranRuntime } from './runtime';

const SESSION_ICONS: Partial<Record<SessionStatus, vscode.ThemeIcon>> = {
  running: new vscode.ThemeIcon('loading~spin'),
  background: new vscode.ThemeIcon('loading~spin'),
  'awaiting-input': new vscode.ThemeIcon('bell-dot'),
};

function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86400))}d ago`;
}

abstract class RefreshableTree<T> implements vscode.TreeDataProvider<T>, vscode.Disposable {
  protected readonly changeEmitter = new vscode.EventEmitter<T | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  protected readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  private timer: NodeJS.Timeout | undefined;

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changeEmitter.fire(), 150);
  }

  abstract getTreeItem(element: T): vscode.TreeItem;
  abstract getChildren(element?: T): vscode.ProviderResult<T[]>;

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export interface SessionNode {
  readonly kind: 'session';
  readonly session: PersistedSessionInfo;
}

export class SessionsTree extends RefreshableTree<SessionNode> {
  constructor(private readonly runtime: AlranRuntime) {
    super();
    this.disposables.push(
      runtime.onDidChangeTabs(() => this.refresh()),
      runtime.onDidChangeConnection(() => this.refresh()),
      runtime.onDidChangeTurn(({ running }) => {
        if (!running) this.refresh();
      }),
    );
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    const { session } = element;
    const open = this.runtime.manager.sessions.get(session.sessionId);
    const item = new vscode.TreeItem(open?.meta.title ?? session.title ?? 'Untitled');
    item.id = session.sessionId;
    item.description = open ? 'open' : relativeTime(session.updatedAt);
    item.tooltip = `${session.cwd}\n${session.sessionId}`;
    item.contextValue = open ? 'session.open' : 'session';
    item.iconPath = (open && SESSION_ICONS[open.meta.status]) || new vscode.ThemeIcon('comment-discussion');
    item.command = {
      command: 'alran.openSession',
      title: 'Open',
      arguments: [element],
    };
    return item;
  }

  async getChildren(element?: SessionNode): Promise<SessionNode[]> {
    if (element) return [];
    const { manager } = this.runtime;
    if (manager.connection.state !== 'connected') return [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    try {
      const lists = folders.length
        ? await Promise.all(folders.map((folder) => manager.listSessions(folder.uri.fsPath)))
        : [await manager.listSessions()];
      return lists
        .flat()
        .filter((session) => session.title || manager.sessions.has(session.sessionId))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .map((session) => ({ kind: 'session', session }));
    } catch {
      return [];
    }
  }
}

export interface ChangeNode {
  readonly kind: 'change';
  readonly change: FileChange;
}

export class ChangesTree extends RefreshableTree<ChangeNode> {
  constructor(private readonly runtime: AlranRuntime) {
    super();
    this.disposables.push(
      runtime.onDidChangeFiles(() => this.refresh()),
      runtime.onDidChangeTabs(() => this.refresh()),
    );
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    const { change } = element;
    const uri = vscode.Uri.file(change.path);
    const item = new vscode.TreeItem(uri);
    item.description = [
      vscode.workspace.asRelativePath(path.dirname(change.path), false),
      change.before === null ? 'added' : change.origin === 'observed' ? 'changed by a command' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    item.contextValue = change.before === undefined ? 'change.unknown' : 'change';
    item.command = { command: 'alran.openChange', title: 'Show Changes', arguments: [element] };
    return item;
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    if (element) return [];
    return (this.runtime.manager.active?.changes.list() ?? []).map((change) => ({
      kind: 'change',
      change,
    }));
  }
}

export interface AgentNode {
  readonly kind: 'agent';
  readonly member: DelegationMemberView;
}

const AGENT_ICONS: Readonly<Record<string, string>> = {
  running: 'loading~spin',
  queued: 'clock',
  completed: 'pass',
  failed: 'error',
  stopped: 'circle-slash',
};

export class AgentsTree extends RefreshableTree<AgentNode> {
  constructor(private readonly runtime: AlranRuntime) {
    super();
    this.disposables.push(
      runtime.onDidChangeMeta(() => this.refresh()),
      runtime.onDidChangeTabs(() => this.refresh()),
    );
  }

  getTreeItem(element: AgentNode): vscode.TreeItem {
    const { member } = element;
    const item = new vscode.TreeItem(member.title);
    item.description = [member.agentName, member.status].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(AGENT_ICONS[member.status] ?? 'circle-outline');
    item.tooltip = member.sessionId;
    return item;
  }

  getChildren(element?: AgentNode): AgentNode[] {
    if (element) return [];
    return (this.runtime.manager.active?.meta.delegation ?? []).map((member) => ({
      kind: 'agent',
      member,
    }));
  }
}

export type CapabilityNode =
  | { readonly kind: 'group'; readonly group: 'skills' | 'mcp' | 'plugins' | 'providers' }
  | { readonly kind: 'skill'; readonly name: string; readonly description: string }
  | { readonly kind: 'mcp'; readonly name: string; readonly detail: string; readonly enabled: boolean }
  | { readonly kind: 'plugin'; readonly plugin: cli.PluginInfo; readonly installed: boolean }
  | { readonly kind: 'provider'; readonly provider: cli.ProviderInfo }
  | { readonly kind: 'message'; readonly text: string };

const GROUP_LABELS = {
  skills: ['Skills', 'wand'],
  mcp: ['MCP Servers', 'plug'],
  plugins: ['Plugins', 'extensions'],
  providers: ['Model Providers', 'server'],
} as const;

export class CapabilitiesTree extends RefreshableTree<CapabilityNode> {
  private installedPlugins: readonly cli.PluginInfo[] = [];

  constructor(private readonly runtime: AlranRuntime) {
    super();
    this.disposables.push(
      runtime.onDidChangeConnection((state) => {
        if (state.state === 'connected') this.refresh();
      }),
      runtime.onDidChangeTabs(() => this.refresh()),
    );
  }

  pluginMentions(): MentionCandidate[] {
    return this.installedPlugins
      .filter((plugin) => plugin.enabled !== false)
      .map((plugin) => ({
        kind: 'plugin',
        label: plugin.displayName ?? plugin.name,
        detail: `Plugin · ${plugin.marketplace ?? plugin.source ?? 'local'}`,
        value: cli.pluginSelector(plugin),
      }));
  }

  /** Loads plugins early so `@` mentions work before the view is opened. */
  async loadPlugins(): Promise<void> {
    const list = await cli.plugins.list(await this.runtime.cliContext());
    this.installedPlugins = list.installed;
  }

  getTreeItem(element: CapabilityNode): vscode.TreeItem {
    switch (element.kind) {
      case 'group': {
        const [label, icon] = GROUP_LABELS[element.group];
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = `group.${element.group}`;
        return item;
      }
      case 'skill': {
        const item = new vscode.TreeItem(`/${element.name}`);
        item.tooltip = element.description;
        item.description = element.description;
        item.contextValue = 'skill';
        item.command = { command: 'alran.insertSkill', title: 'Use Skill', arguments: [element.name] };
        return item;
      }
      case 'mcp': {
        const item = new vscode.TreeItem(element.name);
        item.description = element.detail;
        item.iconPath = new vscode.ThemeIcon(element.enabled ? 'circle-filled' : 'circle-outline');
        return item;
      }
      case 'plugin': {
        const { plugin, installed } = element;
        const item = new vscode.TreeItem(plugin.displayName ?? plugin.name);
        item.description = installed
          ? [plugin.enabled === false ? 'disabled' : 'enabled', plugin.version].filter(Boolean).join(' · ')
          : 'available';
        item.tooltip = plugin.description;
        item.contextValue = !installed
          ? 'plugin.available'
          : plugin.enabled === false
            ? 'plugin.disabled'
            : 'plugin.enabled';
        return item;
      }
      case 'provider': {
        const { provider } = element;
        const item = new vscode.TreeItem(provider.name);
        item.description = [
          provider.active ? 'active' : '',
          provider.hasApiKey ? 'key saved' : '',
          provider.models.length > 0 ? `${String(provider.models.length)} models` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        item.tooltip = provider.providerId;
        item.iconPath = new vscode.ThemeIcon(provider.active ? 'star-full' : 'server');
        item.contextValue = provider.readOnly ? 'provider.readonly' : 'provider.editable';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(element.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  async getChildren(element?: CapabilityNode): Promise<CapabilityNode[]> {
    if (!element) {
      return (['skills', 'mcp', 'plugins', 'providers'] as const).map((group) => ({ kind: 'group', group }));
    }
    if (element.kind !== 'group') return [];
    try {
      return await this.loadGroup(element.group);
    } catch (error) {
      return [{ kind: 'message', text: error instanceof Error ? error.message : String(error) }];
    }
  }

  private async loadGroup(group: 'skills' | 'mcp' | 'plugins' | 'providers'): Promise<CapabilityNode[]> {
    const session = this.runtime.manager.active;
    if (group === 'skills') {
      if (!session) return [{ kind: 'message', text: 'Open a chat to list its Skills.' }];
      const skills = session.meta.commands.filter((command) => command.source === 'skill');
      return skills.length
        ? skills.map((skill) => ({ kind: 'skill', name: skill.name, description: skill.description }))
        : [{ kind: 'message', text: 'No Skills are enabled.' }];
    }
    if (group === 'mcp') {
      if (!session) return [{ kind: 'message', text: 'Open a chat to list its MCP servers.' }];
      if (session.busy) return [{ kind: 'message', text: 'Available when the current turn ends.' }];
      const servers = parseMcpList(await session.captureCommand('/mcp'));
      return servers.length
        ? servers.map((server) => ({ kind: 'mcp', ...server }))
        : [{ kind: 'message', text: 'No MCP servers are configured.' }];
    }
    const context = await this.runtime.cliContext();
    if (group === 'plugins') {
      const list = await cli.plugins.list(context);
      this.installedPlugins = list.installed;
      const nodes: CapabilityNode[] = [
        ...list.installed.map((plugin) => ({ kind: 'plugin' as const, plugin, installed: true })),
        ...list.available.map((plugin) => ({ kind: 'plugin' as const, plugin, installed: false })),
      ];
      if (list.catalogError) {
        nodes.push({ kind: 'message', text: 'The online Plugin catalog is unavailable right now.' });
      }
      return nodes.length ? nodes : [{ kind: 'message', text: 'No Plugins are installed.' }];
    }
    const providers = await cli.providers.list(context);
    return providers.providers.map((provider) => ({ kind: 'provider', provider }));
  }
}

export type AccountNode =
  | {
      readonly kind: 'row';
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly tooltip?: string;
      readonly icon: string;
      readonly command?: vscode.Command;
      readonly contextValue?: string;
      readonly children?: readonly AccountNode[];
    };

/** The Ottili account at a glance: who, where, which model, how much credit. */
export class AccountTree extends RefreshableTree<AccountNode> {
  constructor(
    private readonly runtime: AlranRuntime,
    private readonly account: AccountService,
  ) {
    super();
    this.disposables.push(
      account.onDidChange(() => this.refresh()),
      runtime.onDidChangeConnection(() => this.refresh()),
    );
  }

  getTreeItem(element: AccountNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.id;
    if (element.description) item.description = element.description;
    item.tooltip = element.tooltip ?? (element.description ? `${element.label}: ${element.description}` : element.label);
    item.iconPath = new vscode.ThemeIcon(element.icon);
    if (element.command) item.command = element.command;
    if (element.contextValue) item.contextValue = element.contextValue;
    return item;
  }

  getChildren(element?: AccountNode): AccountNode[] {
    if (element) return [...(element.children ?? [])];
    const snapshot = this.account.snapshot;
    const rows: AccountNode[] = [];
    const run = (command: string, title: string): vscode.Command => ({ command, title });
    const { status, credits, models } = snapshot;
    if (snapshot.unsupported) {
      return [
        {
          kind: 'row',
          id: 'account.unsupported',
          label: 'Update the Alran CLI to manage your account here',
          icon: 'warning',
          command: run('alran.update', 'Update'),
        },
      ];
    }
    if (!status) {
      if (snapshot.error === 'The Alran CLI is not installed.') {
        return [
          {
            kind: 'row',
            id: 'account.nocli',
            label: 'Install the Alran CLI to get started',
            tooltip: 'Alran Code runs the Alran CLI on this machine. Click to install it or point the extension at it.',
            icon: 'cloud-download',
            command: run('alran.installCli', 'Install'),
          },
        ];
      }
      return snapshot.error
        ? [{ kind: 'row', id: 'account.error', label: snapshot.error, icon: 'warning', command: run('alran.refreshAccount', 'Retry') }]
        : [];
    }
    if (!status.signedIn) {
      const credential = snapshot.credential;
      if (credential?.kind === 'api-key') {
        return [
          {
            kind: 'row',
            id: 'account.apikey',
            label: 'Ottili API key',
            description: credential.masked ?? 'saved',
            tooltip: 'Model calls use this API key and its project. Sign in to see credit, usage and billing here.',
            icon: 'key',
          },
          {
            kind: 'row',
            id: 'account.signin',
            label: 'Sign in for credit, usage and billing',
            icon: 'account',
            command: run('alran.login', 'Sign In'),
          },
          { kind: 'row', id: 'account.billing', label: 'Billing and invoices', icon: 'link-external', command: run('alran.openBilling', 'Open Billing') },
        ];
      }
      if (credential?.kind === 'provider') {
        return [
          {
            kind: 'row',
            id: 'account.provider',
            label: 'Your provider',
            description: credential.name,
            tooltip: 'Model calls go directly to this provider with your own key. Ottili does not see or bill them.',
            icon: 'server',
            command: run('alran.capabilities.focus', 'Show Providers'),
          },
          {
            kind: 'row',
            id: 'account.signin',
            label: 'Sign in to use Ottili models',
            icon: 'account',
            command: run('alran.login', 'Sign In'),
          },
        ];
      }
      return [];
    }
    const name = status.name ?? 'Ottili account';
    rows.push({
      kind: 'row',
      id: 'account.user',
      label: name,
      description: status.environment && status.environment !== 'production' ? status.environment : undefined,
      tooltip: [
        `Signed in as ${name}`,
        status.platform ? `Platform: ${status.platform}` : '',
        status.gateway ? `Gateway: ${status.gateway}` : '',
        status.sessionExpiresAt ? `Session valid until ${new Date(status.sessionExpiresAt).toLocaleString()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      icon: 'account',
      contextValue: 'account.user',
    });
    rows.push({
      kind: 'row',
      id: 'account.company',
      label: 'Company',
      description: snapshot.companyName ?? status.companyId ?? '—',
      tooltip: status.companyId ? `Company ${status.companyId}. Model calls, usage and billing use it. Click to switch.` : undefined,
      icon: 'organization',
      command: run('alran.switchCompany', 'Switch Company'),
      contextValue: 'account.company',
    });
    rows.push({
      kind: 'row',
      id: 'account.project',
      label: 'Project',
      description: status.projectId ?? 'Default project',
      icon: 'project',
      command: run('alran.selectProject', 'Choose Project'),
      contextValue: 'account.project',
    });
    const defaultModel = models?.find((model) => model.default);
    rows.push({
      kind: 'row',
      id: 'account.model',
      label: 'Default model',
      description: defaultModel?.name ?? readableModelKey(status.defaultModel),
      icon: 'hubot',
      command: run('alran.pickDefaultModel', 'Choose Default Model'),
      contextValue: 'account.model',
      children: (models ?? []).map((model) => ({
        kind: 'row' as const,
        id: `account.model.${model.key}`,
        label: model.name,
        description: `${formatModelPrice(model)} · ${availabilityLabel(model)}`,
        tooltip: `${model.description}\n${formatModelPrice(model)}\nPaid with ${model.credit}`,
        icon: model.default ? 'star-full' : model.status === 'available' ? 'pass' : 'warning',
      })),
    });
    if (credits) {
      const available = credits.available_microcents ?? 0;
      rows.push({
        kind: 'row',
        id: 'account.credits',
        label: 'Credit',
        description: `${formatMicroUsd(available)} available`,
        icon: available < 500_000 ? 'warning' : 'credit-card',
        contextValue: 'account.credits',
        children: [
          {
            kind: 'row',
            id: 'account.credits.welcome',
            label: 'Welcome credit',
            description: `${formatMicroUsd(credits.free_credit?.remaining_microcents)} of ${formatMicroUsd(credits.free_credit?.granted_microcents)} · Werk only`,
            icon: 'gift',
          },
          {
            kind: 'row',
            id: 'account.credits.paid',
            label: 'Purchased credit',
            description: `${formatMicroUsd(credits.paid_credit?.available_microcents)} · all models`,
            icon: 'credit-card',
          },
          ...(credits.reserved_microcents
            ? [
                {
                  kind: 'row' as const,
                  id: 'account.credits.reserved',
                  label: 'Reserved for running requests',
                  description: formatMicroUsd(credits.reserved_microcents),
                  icon: 'clock',
                },
              ]
            : []),
          {
            kind: 'row',
            id: 'account.credits.add',
            label: 'Add credit…',
            icon: 'add',
            command: run('alran.openBilling', 'Add Credit'),
          },
        ],
      });
      const month = credits.current_month;
      const byModel = month?.by_model ?? [];
      rows.push({
        kind: 'row',
        id: 'account.month',
        label: 'Spent this month',
        description: formatMicroUsd(month?.total_cost_microcents ?? 0),
        tooltip: month?.from ? `Since ${month.from.slice(0, 10)}` : undefined,
        icon: 'graph',
        children: byModel.length
          ? byModel.map((row) => ({
              kind: 'row' as const,
              id: `account.month.${row.model}`,
              label: row.model,
              description: `${formatMicroUsd(row.cost_microcents)} · ${String(row.requests)} request${row.requests === 1 ? '' : 's'}`,
              tooltip: `${String((row.input_tokens ?? 0) + (row.output_tokens ?? 0))} tokens${row.service_fee_microcents ? `\nService fee ${formatMicroUsd(row.service_fee_microcents)}` : ''}`,
              icon: 'symbol-number',
            }))
          : [{ kind: 'row' as const, id: 'account.month.none', label: 'No requests yet this month', icon: 'info' }],
      });
    }
    const billing = snapshot.billing;
    const method = billing?.payment_methods.find((entry) => entry.default) ?? billing?.payment_methods[0];
    rows.push({
      kind: 'row',
      id: 'account.billing',
      label: 'Billing and invoices',
      description: billing ? [billing.plan === 'pay-per-use' ? 'Prepaid credit' : billing.plan, method?.label].filter(Boolean).join(' · ') : undefined,
      tooltip: billing
        ? `Plan: ${billing.plan}\nPayment method: ${method?.label ?? 'none on file'}\nManage at ${billing.manage_at}`
        : 'Add credit, change the payment method and download invoices',
      icon: 'link-external',
      command: run('alran.openBilling', 'Open Billing'),
    });
    const version = this.runtime.manager.agentVersion;
    if (version) {
      const outdated = snapshot.latestVersion && compareVersions(snapshot.latestVersion, version) > 0;
      rows.push({
        kind: 'row',
        id: 'account.cli',
        label: 'Alran CLI',
        description: outdated ? `${version} · ${snapshot.latestVersion ?? ''} available` : version,
        icon: outdated ? 'cloud-download' : 'terminal',
        ...(outdated ? { command: run('alran.update', 'Update') } : {}),
      });
    }
    return rows;
  }
}

/** Compares dotted versions numerically; prerelease suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/u, '').split(/[.-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** "custom_provider:fixture/fixture" → "fixture · your provider fixture". */
export function readableModelKey(key: string | undefined): string {
  if (!key) return '—';
  const custom = /^custom_provider:([^/]+)\/(.+)$/u.exec(key);
  if (custom) return `${custom[2] ?? key} · your provider`;
  return key.replace(/^alran\//u, '');
}
