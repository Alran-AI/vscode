import path from 'node:path';

import * as vscode from 'vscode';

import * as cli from '../core/cli';
import type { FileChange } from '../core/changes';
import type { PersistedSessionInfo } from '../core/manager';
import type { DelegationMemberView, MentionCandidate, SessionStatus } from '../shared/types';
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
