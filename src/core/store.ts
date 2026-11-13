import {
  AlranCliError,
  cliFailureMessage,
  runCli,
  runJson,
  runChecked,
  type CliContext,
  type PluginInfo,
  type PluginList,
} from './cli';

/**
 * The Plugin Store and Skill Library of the Alran CLI (`alran plugin …`,
 * `alran skills …`). A store is a static index; the CLI verifies every
 * download. This module only drives the CLI and shapes its JSON for the UI.
 */

export type StoreKind = 'plugin' | 'skill';

/** The four views of the TUI's `/plugin` Store. */
export type StoreView = 'plugins' | 'library' | 'installed' | 'stores';

export interface StoreItem {
  /** `plugin:name@store` or `skill:name@store`. */
  readonly id: string;
  readonly kind: StoreKind;
  readonly name: string;
  readonly displayName: string;
  /** The store it came from; `built-in` for Skills that ship with Alran Code, `local` for a folder. */
  readonly origin: string;
  readonly version?: string;
  readonly installedVersion?: string;
  readonly description: string;
  readonly author?: string;
  readonly group?: string;
  readonly license?: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly updateAvailable: boolean;
  /** "9 skills · 1 hook" */
  readonly summary: string;
}

export interface StoreListing {
  readonly items: readonly StoreItem[];
  /** The CLI's own notes, e.g. a store that could not be read. */
  readonly notes: readonly string[];
}

export interface StoreSource {
  readonly name: string;
  readonly kind: string;
  readonly location: string;
  readonly builtin: boolean;
  readonly error?: string;
}

export type StoreOutcome =
  | { readonly status: 'done'; readonly output: string }
  | { readonly status: 'needs-approval'; readonly commands: readonly string[] };

interface RawListing {
  readonly items?: readonly Partial<StoreItem>[];
  readonly notes?: readonly string[];
}

export const BUILT_IN_ORIGIN = 'built-in';
const LONG_TIMEOUT_MS = 180_000;

/** What `plugin install` prints when it needs a person to approve what the Plugin runs. */
export function parseApprovalRequest(output: string): string[] | undefined {
  if (!/run again with --yes|will run commands or connect to services/iu.test(output)) return undefined;
  const commands: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*[•*-]\s+(\S.*?)\s*$/u.exec(line);
    if (match?.[1]) commands.push(match[1]);
  }
  return commands;
}

/** `name@store`, the selector the CLI accepts when several stores offer one name. */
export function storeSelector(item: Pick<StoreItem, 'name' | 'origin'>): string {
  return item.origin ? `${item.name}@${item.origin}` : item.name;
}

export function isBuiltIn(item: Pick<StoreItem, 'origin'>): boolean {
  return item.origin === BUILT_IN_ORIGIN;
}

/** What Enter does on a row: the one thing a person most likely wants. */
export type PrimaryAction = 'install' | 'update' | 'details';

export function primaryAction(item: StoreItem): PrimaryAction {
  if (isBuiltIn(item)) return 'details';
  if (!item.installed) return 'install';
  return item.updateAvailable ? 'update' : 'details';
}

function normalizeItem(raw: Partial<StoreItem>, kind: StoreKind): StoreItem | undefined {
  if (!raw.name) return undefined;
  const origin = raw.origin ?? '';
  return {
    id: raw.id ?? `${kind}:${raw.name}@${origin}`,
    kind: raw.kind ?? kind,
    name: raw.name,
    displayName: raw.displayName?.trim() || raw.name,
    origin,
    ...(raw.version ? { version: raw.version } : {}),
    ...(raw.installedVersion ? { installedVersion: raw.installedVersion } : {}),
    description: raw.description?.trim() ?? '',
    ...(raw.author ? { author: raw.author } : {}),
    ...(raw.group ? { group: raw.group } : {}),
    ...(raw.license ? { license: raw.license } : {}),
    installed: raw.installed === true,
    enabled: raw.enabled === true,
    updateAvailable: raw.updateAvailable === true,
    summary: raw.summary ?? '',
  };
}

function normalizeListing(raw: RawListing, kind: StoreKind): StoreListing {
  const items = (raw.items ?? []).flatMap((entry) => {
    const item = normalizeItem(entry, kind);
    return item ? [item] : [];
  });
  return { items, notes: raw.notes ?? [] };
}

/** A Plugin as `plugin list --json` reports it (installed or on offer), in the shape of a Store row. */
export function itemFromPluginInfo(plugin: PluginInfo): StoreItem {
  const origin = plugin.marketplaceName ?? plugin.marketplace ?? plugin.source ?? 'local';
  const capabilities = plugin.capabilities ?? {};
  const parts = [
    count(capabilities.skillCount, 'skill'),
    count(capabilities.mcpServerCount, 'MCP server'),
    count(capabilities.appCount, 'app'),
  ].filter((part): part is string => part !== undefined);
  return {
    id: `plugin:${plugin.name}@${origin}`,
    kind: 'plugin',
    name: plugin.name,
    displayName: plugin.displayName?.trim() || plugin.name,
    origin,
    ...(plugin.version ? { version: plugin.version, installedVersion: plugin.version } : {}),
    description: plugin.description?.trim() ?? '',
    ...(plugin.author ? { author: plugin.author } : {}),
    installed: plugin.installed !== false,
    enabled: plugin.installed !== false && plugin.enabled !== false,
    updateAvailable: false,
    summary: parts.join(' · '),
  };
}

/** A Plugin or Skill named by hand: `name` or `name@store`. */
export function itemFromSelector(selector: string, kind: StoreKind = 'plugin'): StoreItem {
  const at = selector.lastIndexOf('@');
  const name = at > 0 ? selector.slice(0, at) : selector;
  const origin = at > 0 ? selector.slice(at + 1) : '';
  return {
    id: `${kind}:${name}@${origin}`,
    kind,
    name,
    displayName: name,
    origin,
    description: '',
    installed: false,
    enabled: false,
    updateAvailable: false,
    summary: '',
  };
}

function count(value: number | undefined, noun: string): string | undefined {
  if (!value) return undefined;
  return `${String(value)} ${noun}${value === 1 ? '' : 's'}`;
}

/** Library rows grouped by the store's own groups; "Built in" comes last. */
export function groupLibrary(items: readonly StoreItem[]): Array<{ readonly group: string; readonly items: StoreItem[] }> {
  const groups = new Map<string, StoreItem[]>();
  for (const item of items) {
    const key = item.group ?? 'Other';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const rank = (group: string) => (group === 'Built in' ? 2 : group === 'Other' ? 1 : 0);
  return [...groups.entries()]
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
    .map(([group, rows]) => ({
      group,
      items: rows.sort((left, right) => left.displayName.localeCompare(right.displayName)),
    }));
}

export function itemState(item: StoreItem): string {
  if (isBuiltIn(item)) return 'Built in';
  if (!item.installed) return item.version ?? '';
  if (item.updateAvailable) {
    return `Update available · ${item.installedVersion ?? '?'} → ${item.version ?? '?'}`;
  }
  const state = item.kind === 'plugin' && !item.enabled ? 'Installed, off' : 'Installed';
  return item.installedVersion ?? item.version ? `${state} · ${item.installedVersion ?? item.version ?? ''}` : state;
}

async function approvalAware(
  context: CliContext,
  args: readonly string[],
  approved: boolean,
): Promise<StoreOutcome> {
  const result = await runCli(context, approved ? [...args, '--yes'] : args, { timeoutMs: LONG_TIMEOUT_MS });
  if (result.code === 0) return { status: 'done', output: result.stdout };
  const commands = approved ? undefined : parseApprovalRequest(`${result.stderr}\n${result.stdout}`);
  if (commands) return { status: 'needs-approval', commands };
  throw new AlranCliError(cliFailureMessage(result, args), result);
}

const noun = (item: Pick<StoreItem, 'kind'>) => (item.kind === 'plugin' ? 'plugin' : 'skills');

export const store = {
  /** Plugins the stores offer. `refresh` asks the stores again instead of using the cached index. */
  async plugins(context: CliContext, refresh = false): Promise<StoreListing> {
    const raw = await runJson<RawListing>(context, ['plugin', 'search', ...(refresh ? ['--refresh'] : [])]);
    return normalizeListing(raw, 'plugin');
  },

  /** Every Skill the stores offer, plus the ones that ship with Alran Code. */
  async library(context: CliContext, refresh = false): Promise<StoreListing> {
    if (refresh) await runChecked(context, ['skills', 'search', '--refresh', '--json'], { timeoutMs: LONG_TIMEOUT_MS });
    return normalizeListing(await runJson<RawListing>(context, ['skills', 'list']), 'skill');
  },

  /** Installed Plugins and Skills; commands about what is installed never touch the network. */
  async installed(context: CliContext): Promise<StoreListing> {
    const [plugins, skills] = await Promise.all([
      runJson<PluginList>(context, ['plugin', 'list']),
      runJson<RawListing>(context, ['skills', 'list', '--installed']),
    ]);
    const skillRows = normalizeListing(skills, 'skill');
    return {
      items: [...plugins.installed.map(itemFromPluginInfo), ...skillRows.items],
      notes: skillRows.notes,
    };
  },

  sources: (context: CliContext) => runJson<StoreSource[]>(context, ['plugin', 'marketplace', 'list']),

  /** The CLI's own description: what is in it, and example prompts. */
  info: (context: CliContext, item: StoreItem) =>
    runChecked(context, [noun(item), 'info', storeSelector(item)]),

  install(context: CliContext, item: StoreItem, approved = false): Promise<StoreOutcome> {
    return approvalAware(context, [noun(item), 'install', storeSelector(item)], approved && item.kind === 'plugin');
  },

  update(context: CliContext, item: StoreItem, approved = false): Promise<StoreOutcome> {
    return approvalAware(context, [noun(item), 'update', storeSelector(item)], approved && item.kind === 'plugin');
  },

  async remove(context: CliContext, item: StoreItem): Promise<void> {
    await runChecked(context, [noun(item), 'remove', storeSelector(item)], { timeoutMs: LONG_TIMEOUT_MS });
  },

  async setEnabled(context: CliContext, item: StoreItem, enabled: boolean): Promise<void> {
    await runChecked(context, ['plugin', enabled ? 'enable' : 'disable', storeSelector(item)], {
      timeoutMs: LONG_TIMEOUT_MS,
    });
  },

  async addSource(context: CliContext, location: string, name?: string): Promise<void> {
    await runChecked(context, ['plugin', 'marketplace', 'add', location, ...(name ? ['--name', name] : [])], {
      timeoutMs: LONG_TIMEOUT_MS,
    });
  },

  async removeSource(context: CliContext, name: string): Promise<void> {
    await runChecked(context, ['plugin', 'marketplace', 'remove', name]);
  },
};
