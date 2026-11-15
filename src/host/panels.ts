import * as vscode from 'vscode';

import type { PanelAction, PanelPage, PanelRow, PanelView } from '../shared/panels';
import type { AccountService } from './account';
import type { AlranRuntime } from './runtime';
import type { AccountTree, AgentsTree, CapabilitiesTree, ChangesTree, SessionsTree } from './trees';

/** What a row or a button runs. Kept here, never sent to the webview: it names the node, not the command. */
interface Invocation {
  readonly command: string;
  readonly args: readonly unknown[];
}

interface TreeLike<T> {
  getChildren(element?: T): vscode.ProviderResult<T[]>;
  getTreeItem(element: T): vscode.TreeItem | Thenable<vscode.TreeItem>;
  readonly onDidChangeTreeData: vscode.Event<T | undefined | void>;
}

interface Source {
  readonly tree: TreeLike<unknown>;
  readonly title: string;
  readonly empty: string;
  readonly emptyActions: readonly (readonly [string, string, string])[];
}

const MAX_DEPTH = 3;

/** Inline buttons per `contextValue`: what the editor's tree views offered as inline commands. */
const ROW_ACTIONS: Readonly<Record<string, readonly (readonly [string, string, string])[]>> = {
  session: [['alran.forkSession', 'repo-forked', 'Fork this session']],
  'session.open': [
    ['alran.forkSession', 'repo-forked', 'Fork this session'],
    ['alran.closeSession', 'close', 'Close this session tab'],
  ],
  change: [['alran.revertChange', 'discard', 'Revert this file']],
  'plugin.available': [['alran.pluginInstall', 'cloud-download', 'Install']],
  'plugin.enabled': [
    ['alran.pluginDisable', 'circle-slash', 'Disable'],
    ['alran.pluginUninstall', 'trash', 'Uninstall'],
  ],
  'plugin.disabled': [
    ['alran.pluginEnable', 'check', 'Enable'],
    ['alran.pluginUninstall', 'trash', 'Uninstall'],
  ],
  'group.plugins': [
    ['alran.openStore', 'extensions', 'Browse the Plugin Store'],
    ['alran.pluginInstallBySelector', 'add', 'Install a plugin by name'],
    ['alran.pluginMarketplaceUpgrade', 'sync', 'Refresh plugin sources'],
  ],
  'group.skills': [['alran.openSkillLibrary', 'library', 'Browse the Skill Library']],
  'group.providers': [
    ['alran.providerAdd', 'add', 'Add a model provider'],
    ['alran.providerSetKey', 'key', 'Use an Ottili API key'],
  ],
  'provider.editable': [
    ['alran.providerTest', 'beaker', 'Test this provider'],
    ['alran.providerRemove', 'trash', 'Remove this provider'],
  ],
  'provider.readonly': [['alran.providerTest', 'beaker', 'Test this provider']],
  'account.company': [['alran.switchCompany', 'organization', 'Switch company']],
  'account.project': [['alran.selectProject', 'project', 'Choose project']],
  'account.model': [['alran.pickDefaultModel', 'star-empty', 'Choose the default model']],
  'account.credits': [['alran.openBilling', 'credit-card', 'Add credit']],
  'account.user': [['alran.logout', 'sign-out', 'Sign out']],
};

/** Page-level buttons: what the tree views had in their title bars. */
const TOOLBARS: Readonly<Record<PanelPage, readonly (readonly [string, string, string])[]>> = {
  sessions: [
    ['alran.newSession', 'add', 'New session'],
    ['alran.resumeSession', 'history', 'Resume a session'],
    ['alran.refreshSessions', 'refresh', 'Refresh'],
  ],
  changes: [
    ['alran.revertAllChanges', 'discard', 'Revert all changes'],
    ['alran.clearChanges', 'clear-all', 'Clear the list'],
    ['alran.refreshChanges', 'refresh', 'Refresh'],
  ],
  agents: [['alran.agentsStop', 'debug-stop', 'Stop all sub-agents']],
  capabilities: [
    ['alran.openStore', 'extensions', 'Plugin Store'],
    ['alran.openSkillLibrary', 'library', 'Skill Library'],
    ['alran.refreshCapabilities', 'refresh', 'Refresh'],
  ],
  account: [
    ['alran.openBilling', 'credit-card', 'Add credit and manage billing'],
    ['alran.loginOptions', 'sign-in', 'Sign in or change how you connect'],
    ['alran.refreshAccount', 'refresh', 'Refresh'],
    ['alran.update', 'cloud-download', 'Update the Alran CLI'],
  ],
};

const TITLES: Readonly<Record<PanelPage, string>> = {
  sessions: 'Sessions',
  changes: 'Changes',
  agents: 'Sub-agents',
  capabilities: 'Capabilities',
  account: 'Account',
};

const EMPTY: Readonly<
  Record<PanelPage, { readonly text: string; readonly actions: readonly (readonly [string, string, string])[] }>
> = {
  sessions: {
    text: 'Your previous sessions in this workspace appear here.',
    actions: [['alran.resumeSession', 'history', 'Resume a session…']],
  },
  changes: { text: 'Files the current session changes appear here, with a diff and a one-click revert.', actions: [] },
  agents: { text: 'Sub-agents the current session starts appear here while they work.', actions: [] },
  capabilities: { text: 'Open a chat to list its skills, MCP servers, plugins and model providers.', actions: [] },
  account: {
    text: 'Sign in with your Ottili account to use Ottili Werk and Claude models and to see your credit and usage here. No account? Use your own model provider with your own API key.',
    actions: [
      ['alran.login', 'account', 'Sign in'],
      ['alran.loginOptions', 'sign-in', 'Other ways to connect…'],
      ['alran.providerAdd', 'server', 'Use my own provider'],
    ],
  },
};

/**
 * The Alran pages next to the chat. The data sources are the same providers that used to feed the
 * editor's tree views; here they become rows for the chat webview, and a click or button is mapped
 * back to the stored node on this side, so the webview never names a command or an argument.
 */
export class PanelHost implements vscode.Disposable {
  private readonly sources: Readonly<Record<PanelPage, Source>>;
  private readonly invocations = new Map<string, Invocation>();
  private readonly toolbarInvocations = new Map<string, Invocation>();
  private readonly changeEmitter = new vscode.EventEmitter<PanelPage>();
  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  /** Loads that are running or done for the page, so a burst of refreshes is one load. */
  private readonly building = new Map<PanelPage, Promise<PanelView>>();

  /** A page's data changed; the hub re-sends it when that page is open. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly runtime: AlranRuntime,
    private readonly account: AccountService,
    trees: {
      readonly sessions: SessionsTree;
      readonly changes: ChangesTree;
      readonly agents: AgentsTree;
      readonly capabilities: CapabilitiesTree;
      readonly account: AccountTree;
    },
  ) {
    const source = <T,>(page: PanelPage, tree: TreeLike<T>): Source => ({
      tree: tree as unknown as TreeLike<unknown>,
      title: TITLES[page],
      empty: EMPTY[page].text,
      emptyActions: EMPTY[page].actions,
    });
    this.sources = {
      sessions: source('sessions', trees.sessions),
      changes: source('changes', trees.changes),
      agents: source('agents', trees.agents),
      capabilities: source('capabilities', trees.capabilities),
      account: source('account', trees.account),
    };
    for (const page of Object.keys(this.sources) as PanelPage[]) {
      this.disposables.push(
        this.sources[page].tree.onDidChangeTreeData(() => {
          this.building.delete(page);
          this.changeEmitter.fire(page);
        }),
      );
    }
  }

  /** Counts for the navigation badges, without loading a page. */
  badges(): { readonly changes: number; readonly agents: number } {
    const session = this.runtime.manager.active;
    return {
      changes: session?.changes.list().length ?? 0,
      agents: (session?.meta.delegation ?? []).filter(
        (member) => member.status === 'running' || member.status === 'queued',
      ).length,
    };
  }

  build(page: PanelPage): Promise<PanelView> {
    const running = this.building.get(page);
    if (running) return running;
    const next = this.load(page).finally(() => {
      // A finished load is not cached: the next open asks again, so it is never stale.
      if (this.building.get(page) === next) this.building.delete(page);
    });
    this.building.set(page, next);
    return next;
  }

  private async load(page: PanelPage): Promise<PanelView> {
    const source = this.sources[page];
    this.clear(page);
    const rows = await this.rows(page, source.tree, undefined, `${page}:`, 0);
    this.toolbarInvocations.clear();
    const toolbar: PanelAction[] = [];
    for (const [command, icon, label] of TOOLBARS[page]) {
      if (page === 'account' && !this.toolbarApplies(command)) continue;
      const id = `${page}:tb:${command}`;
      this.toolbarInvocations.set(id, { command, args: [] });
      toolbar.push({ id, label, icon });
    }
    const emptyActions: PanelAction[] = [];
    for (const [command, icon, label] of source.emptyActions) {
      const id = `${page}:empty:${command}`;
      this.toolbarInvocations.set(id, { command, args: [] });
      emptyActions.push({ id, label, icon });
    }
    return {
      page,
      title: source.title,
      rows,
      toolbar,
      ...(rows.length === 0 ? { empty: source.empty, emptyActions } : {}),
    };
  }

  /** Account buttons that make no sense in the current state are left out. */
  private toolbarApplies(command: string): boolean {
    const signedIn = this.account.signedIn;
    if (command === 'alran.openBilling') return signedIn;
    if (command === 'alran.loginOptions') return true;
    return true;
  }

  private clear(page: PanelPage): void {
    for (const key of [...this.invocations.keys()]) if (key.startsWith(`${page}:`)) this.invocations.delete(key);
  }

  private async rows(
    page: PanelPage,
    tree: TreeLike<unknown>,
    parent: unknown,
    prefix: string,
    depth: number,
  ): Promise<PanelRow[]> {
    const nodes = (await tree.getChildren(parent)) ?? [];
    const rows: PanelRow[] = [];
    let index = 0;
    for (const node of nodes) {
      const item = await tree.getTreeItem(node);
      const id = `${prefix}${String(index)}`;
      index += 1;
      rows.push(await this.toRow(page, tree, node, item, id, depth));
    }
    return rows;
  }

  private async toRow(
    page: PanelPage,
    tree: TreeLike<unknown>,
    node: unknown,
    item: vscode.TreeItem,
    id: string,
    depth: number,
  ): Promise<PanelRow> {
    const label = labelOf(item);
    const icon = iconOf(item);
    const contextValue = item.contextValue ?? '';
    const actions: PanelAction[] = [];
    for (const [command, actionIcon, actionLabel] of ROW_ACTIONS[contextValue] ?? []) {
      const actionId = `${id}:${command}`;
      this.invocations.set(actionId, { command, args: argsFor(command, node) });
      actions.push({ id: actionId, label: actionLabel, icon: actionIcon });
    }
    let clickable = false;
    if (item.command) {
      clickable = true;
      this.invocations.set(id, { command: item.command.command, args: item.command.arguments ?? [] });
    }
    const group = contextValue.startsWith('group.');
    const collapsible = item.collapsibleState !== undefined && item.collapsibleState !== vscode.TreeItemCollapsibleState.None;
    let children: PanelRow[] | undefined;
    if (collapsible && depth + 1 < MAX_DEPTH) {
      try {
        children = await this.rows(page, tree, node, `${id}.`, depth + 1);
      } catch (error) {
        children = [errorRow(`${id}.err`, error)];
      }
    }
    const description = typeof item.description === 'string' ? item.description : undefined;
    const tooltip = typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value;
    const note = !clickable && actions.length === 0 && icon === 'info' && !collapsible;
    return {
      id,
      label,
      ...(description ? { description } : {}),
      ...(tooltip ? { tooltip } : {}),
      ...(icon ? { icon } : {}),
      clickable,
      actions,
      ...(children ? { children } : {}),
      ...(group ? { group: true } : {}),
      ...(note ? { note: true } : {}),
    };
  }

  /** Runs what a row, or one of its buttons, stands for. `actionId` is absent for a click on the row. */
  async run(rowId: string, actionId?: string): Promise<void> {
    const target = this.invocations.get(actionId ?? rowId);
    if (!target) return;
    await vscode.commands.executeCommand(target.command, ...target.args);
  }

  async runToolbar(actionId: string): Promise<void> {
    const target = this.toolbarInvocations.get(actionId);
    if (!target) return;
    await vscode.commands.executeCommand(target.command, ...target.args);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** The commands the tree views called with their node take it back from the stored row. */
function argsFor(command: string, node: unknown): readonly unknown[] {
  switch (command) {
    case 'alran.forkSession':
    case 'alran.closeSession':
    case 'alran.revertChange':
    case 'alran.pluginInstall':
    case 'alran.pluginUninstall':
    case 'alran.pluginEnable':
    case 'alran.pluginDisable':
    case 'alran.providerTest':
    case 'alran.providerRemove':
      return [node];
    default:
      return [];
  }
}

function labelOf(item: vscode.TreeItem): string {
  if (typeof item.label === 'string') return item.label;
  if (item.label) return item.label.label;
  if (item.resourceUri) {
    const parts = item.resourceUri.path.split('/');
    return parts[parts.length - 1] ?? item.resourceUri.path;
  }
  return '';
}

function iconOf(item: vscode.TreeItem): string | undefined {
  const icon = item.iconPath;
  if (icon instanceof vscode.ThemeIcon) return icon.id;
  return undefined;
}

function errorRow(id: string, error: unknown): PanelRow {
  return {
    id,
    label: error instanceof Error ? error.message : String(error),
    icon: 'warning',
    clickable: false,
    actions: [],
    note: true,
  };
}
