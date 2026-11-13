import * as vscode from 'vscode';

import {
  groupLibrary,
  isBuiltIn,
  itemState,
  primaryAction,
  store,
  type StoreItem,
  type StoreListing,
  type StoreSource,
  type StoreView,
} from '../core/store';
import type { AlranActions } from './actions';
import type { VirtualDocuments } from './diff';
import type { AlranRuntime } from './runtime';

export type RowAction = 'install' | 'update' | 'details' | 'remove' | 'enable' | 'disable' | 'remove-store';

interface RowButton extends vscode.QuickInputButton {
  readonly action: RowAction;
}

export interface StoreRow extends vscode.QuickPickItem {
  readonly item?: StoreItem;
  readonly source?: StoreSource;
  readonly command?: 'add-store';
  readonly buttons?: readonly RowButton[];
}

interface ViewButton extends vscode.QuickInputButton {
  readonly view?: StoreView;
  readonly refresh?: true;
}

const VIEWS: ReadonlyArray<{ readonly id: StoreView; readonly title: string; readonly icon: string; readonly placeholder: string }> = [
  { id: 'plugins', title: 'Plugins', icon: 'extensions', placeholder: 'Search Plugins: names, authors, descriptions' },
  { id: 'library', title: 'Skill Library', icon: 'library', placeholder: 'Search Skills: names, groups, descriptions' },
  { id: 'installed', title: 'Installed', icon: 'check-all', placeholder: 'Search what is installed' },
  { id: 'stores', title: 'Stores', icon: 'globe', placeholder: 'Stores Plugins and Skills come from' },
];

const MAX_DETAIL = 220;

function shorten(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}

function button(action: RowAction, icon: string, tooltip: string): RowButton {
  return { action, iconPath: new vscode.ThemeIcon(icon), tooltip };
}

function itemIcon(item: StoreItem): string {
  if (isBuiltIn(item)) return 'lock';
  if (item.installed && item.updateAvailable) return 'arrow-circle-up';
  if (item.installed) return item.kind === 'plugin' && !item.enabled ? 'circle-slash' : 'pass-filled';
  return item.kind === 'plugin' ? 'package' : 'book';
}

/** The rows of one Plugin or Skill: Enter does the first button's job. */
export function rowForItem(item: StoreItem, view: StoreView): StoreRow {
  const buttons: RowButton[] = [];
  const action = primaryAction(item);
  if (action === 'install') buttons.push(button('install', 'cloud-download', 'Install'));
  if (action === 'update') buttons.push(button('update', 'cloud-download', 'Update'));
  buttons.push(button('details', 'info', 'Details'));
  if (item.installed && !isBuiltIn(item)) {
    if (item.kind === 'plugin') {
      buttons.push(item.enabled ? button('disable', 'circle-slash', 'Switch off') : button('enable', 'play-circle', 'Switch on'));
    }
    buttons.push(button('remove', 'trash', 'Remove'));
  }
  const description = [itemState(item), view === 'library' ? '' : item.group ?? '', item.author ?? '']
    .filter(Boolean)
    .join(' · ');
  const detail = [item.summary, shorten(item.description)].filter(Boolean).join(' — ');
  return {
    label: `$(${itemIcon(item)}) ${item.displayName}`,
    description,
    detail,
    item,
    buttons,
  };
}

function separator(label: string): StoreRow {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function noteRow(note: string): StoreRow {
  return { label: `$(warning) ${shorten(note.replace(/^note:\s*/iu, ''))}`, alwaysShow: true };
}

/** The rows of a view; also what the tests read to see what a person would see. */
export function buildRows(view: StoreView, listing: StoreListing, sources: readonly StoreSource[] = []): StoreRow[] {
  const notes = listing.notes.map(noteRow);
  if (view === 'stores') {
    return [
      { label: '$(add) Add a store…', description: 'A web address, a folder or an index.json', alwaysShow: true, command: 'add-store' },
      ...sources.map<StoreRow>((source) => ({
        label: `$(${source.kind === 'directory' ? 'folder' : 'globe'}) ${source.name}`,
        description: source.builtin ? `${source.kind} · built in` : source.kind,
        detail: source.error ? `$(warning) ${source.error}` : source.location,
        source,
        buttons: source.builtin ? [] : [button('remove-store', 'trash', 'Remove this store')],
      })),
      ...notes,
    ];
  }
  if (view === 'library') {
    return [
      ...notes,
      ...groupLibrary(listing.items).flatMap(({ group, items }) => [
        separator(group),
        ...items.map((item) => rowForItem(item, view)),
      ]),
    ];
  }
  if (view === 'installed') {
    const plugins = listing.items.filter((item) => item.kind === 'plugin');
    const skills = listing.items.filter((item) => item.kind === 'skill');
    const rows: StoreRow[] = [...notes];
    if (plugins.length > 0) rows.push(separator('Plugins'), ...plugins.map((item) => rowForItem(item, view)));
    if (skills.length > 0) rows.push(separator('Skills'), ...skills.map((item) => rowForItem(item, view)));
    if (plugins.length + skills.length === 0) {
      rows.push({ label: '$(info) Nothing is installed yet', description: 'Open Plugins or Skill Library to install something', alwaysShow: true });
    }
    return rows;
  }
  const rows = [...listing.items]
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map((item) => rowForItem(item, view));
  if (rows.length === 0 && listing.notes.length === 0) {
    rows.push({ label: '$(info) No Plugins on offer', description: 'Add a store in the Stores view', alwaysShow: true });
  }
  return [...notes, ...rows];
}

/**
 * The Plugin Store and Skill Library as one Quick Pick, the native
 * counterpart of the TUI's `/plugin`. Enter installs (or updates, or shows
 * details); the buttons on a row do the rest. Every download is verified by the
 * CLI, and a Plugin that runs commands is shown to the person before it is
 * written.
 */
export class StoreBrowser implements vscode.Disposable {
  private picker: vscode.QuickPick<StoreRow> | undefined;
  private current: StoreView = 'plugins';
  private changed = false;
  private loadToken = 0;

  constructor(
    private readonly runtime: AlranRuntime,
    private readonly actions: AlranActions,
    private readonly documents: VirtualDocuments,
  ) {}

  get view(): StoreView {
    return this.current;
  }

  get rows(): readonly StoreRow[] {
    return this.picker?.items ?? [];
  }

  get isOpen(): boolean {
    return this.picker !== undefined;
  }

  /** What is typed in the search box. */
  get query(): string {
    return this.picker?.value ?? '';
  }

  /** A question the person must answer before anything is installed or removed. Tests replace it. */
  ask: (request: { readonly message: string; readonly detail: string; readonly accept: string }) => Promise<boolean> = async (request) =>
    (await vscode.window.showWarningMessage(request.message, { modal: true, detail: request.detail }, request.accept)) === request.accept;

  dispose(): void {
    this.picker?.dispose();
  }

  close(): void {
    this.picker?.hide();
  }

  async open(view: StoreView = 'plugins', query = ''): Promise<void> {
    this.picker?.dispose();
    const picker = vscode.window.createQuickPick<StoreRow>();
    this.picker = picker;
    this.changed = false;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.ignoreFocusOut = true;
    picker.value = query;
    picker.buttons = [
      ...VIEWS.map<ViewButton>((entry) => ({ view: entry.id, iconPath: new vscode.ThemeIcon(entry.icon), tooltip: entry.title })),
      { refresh: true, iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Ask the stores again' } as ViewButton,
    ];
    picker.onDidTriggerButton((triggered) => {
      const target = triggered as ViewButton;
      if (target.view) void this.show(target.view);
      else if (target.refresh) void this.show(this.current, true);
    });
    picker.onDidTriggerItemButton((event) => {
      const action = (event.button as RowButton).action;
      void this.perform(action, event.item);
    });
    picker.onDidAccept(() => {
      const row = picker.selectedItems[0];
      if (row) void this.accept(row);
    });
    picker.onDidHide(() => {
      if (this.picker !== picker) return;
      this.picker = undefined;
      picker.dispose();
      void this.offerReload();
    });
    picker.show();
    await this.show(view);
  }

  /** Loads a view into the open picker. */
  async show(view: StoreView, refresh = false): Promise<void> {
    const picker = this.picker;
    if (!picker) return;
    this.current = view;
    const definition = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0]!;
    picker.title = `Alran Store · ${definition.title}`;
    picker.placeholder = definition.placeholder;
    picker.busy = true;
    const token = (this.loadToken += 1);
    try {
      const context = await this.runtime.cliContext();
      const listing: StoreListing =
        view === 'plugins'
          ? await store.plugins(context, refresh)
          : view === 'library'
            ? await store.library(context, refresh)
            : view === 'installed'
              ? await store.installed(context)
              : { items: [], notes: [] };
      const sources = view === 'stores' ? await store.sources(context) : [];
      if (token !== this.loadToken || this.picker !== picker) return;
      picker.items = buildRows(view, listing, sources);
    } catch (error) {
      if (token !== this.loadToken || this.picker !== picker) return;
      picker.items = [{ label: `$(error) ${shorten(error instanceof Error ? error.message : String(error))}`, alwaysShow: true }];
      await this.actions.reportError(error);
    } finally {
      if (token === this.loadToken) picker.busy = false;
    }
  }

  /** Enter on a row. */
  async accept(row: StoreRow): Promise<void> {
    if (row.command === 'add-store') {
      await this.addStore();
      return;
    }
    if (row.item) await this.perform(primaryAction(row.item), row);
  }

  /** One of the buttons of a row (or what Enter stands for). */
  async perform(action: RowAction, row: StoreRow): Promise<void> {
    const item = row.item;
    const picker = this.picker;
    if (picker) picker.busy = true;
    try {
      await this.actions.guarded(async () => {
        if (action === 'remove-store' && row.source) await this.removeStore(row.source);
        else if (item) await this.apply(action, item);
      });
    } finally {
      if (this.picker === picker && picker) {
        picker.busy = false;
        if (action !== 'details') await this.show(this.current);
      }
    }
  }

  /**
   * Does one thing to one Plugin or Skill, asking before anything that needs
   * a decision. True when it changed what is installed.
   */
  async apply(action: RowAction, item: StoreItem): Promise<boolean> {
    const before = this.changed;
    this.changed = false;
    try {
      await this.act(action, item);
      return this.changed;
    } finally {
      this.changed = before || this.changed;
    }
  }

  private async act(action: RowAction, item: StoreItem): Promise<void> {
    const context = await this.runtime.cliContext();
    const name = item.displayName;
    switch (action) {
      case 'details': {
        const text = await store.info(context, item);
        const uri = this.documents.create(`${name}.txt`, text.trim());
        await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
        return;
      }
      case 'install':
      case 'update': {
        const run = action === 'install' ? store.install : store.update;
        let outcome = await run(context, item, false);
        if (outcome.status === 'needs-approval') {
          const approved = await this.ask({
            message: `${name} runs commands or connects to services`,
            detail: `${outcome.commands.map((command) => `• ${command}`).join('\n')}\n\nOnly approve Plugins from a store you trust.`,
            accept: action === 'install' ? 'Approve and Install' : 'Approve and Update',
          });
          if (!approved) return;
          outcome = await run(context, item, true);
        }
        this.changed = true;
        void vscode.window.setStatusBarMessage(`$(check) ${name} ${action === 'install' ? 'installed' : 'updated'}`, 4_000);
        return;
      }
      case 'remove': {
        const confirmed = await this.ask({
          message: `Remove ${name}?`,
          detail: item.kind === 'plugin' ? 'Its Skills, MCP servers and hooks stop working.' : 'You can install it again from the Skill Library.',
          accept: 'Remove',
        });
        if (!confirmed) return;
        await store.remove(context, item);
        this.changed = true;
        void vscode.window.setStatusBarMessage(`$(check) ${name} removed`, 4_000);
        return;
      }
      case 'enable':
      case 'disable':
        await store.setEnabled(context, item, action === 'enable');
        this.changed = true;
        void vscode.window.setStatusBarMessage(`$(check) ${name} switched ${action === 'enable' ? 'on' : 'off'}`, 4_000);
        return;
      case 'remove-store':
        return;
    }
  }

  async addStore(): Promise<void> {
    const location = await vscode.window.showInputBox({
      title: 'Add a store',
      prompt: 'An https address, a folder, or an index.json. Only add stores you trust: whoever controls a store controls what it lists.',
      placeHolder: 'https://example.com/store',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a web address or a path'),
    });
    if (!location?.trim()) return;
    const name = await vscode.window.showInputBox({
      title: 'Name of the store',
      prompt: 'Optional. Selects its packages as name@store.',
      ignoreFocusOut: true,
    });
    if (name === undefined) return;
    await this.actions.guarded(async () => {
      await store.addSource(await this.runtime.cliContext(), location.trim(), name.trim() || undefined);
      this.changed = true;
    });
    await this.show('stores');
  }

  private async removeStore(source: StoreSource): Promise<void> {
    const confirmed = await this.ask({
      message: `Remove the store “${source.name}”?`,
      detail: 'What you installed from it stays.',
      accept: 'Remove Store',
    });
    if (!confirmed) return;
    await store.removeSource(await this.runtime.cliContext(), source.name);
    this.changed = true;
  }

  /** Skills and Plugins load when a session starts; an open session keeps the ones it began with. */
  private async offerReload(): Promise<void> {
    if (!this.changed) return;
    this.changed = false;
    const fresh = 'New Chat';
    const choice = await vscode.window.showInformationMessage(
      'Plugins and Skills changed. They load in new chats; open chats keep what they started with.',
      fresh,
    );
    if (choice === fresh) await this.actions.guarded(() => this.actions.newSession());
  }
}
