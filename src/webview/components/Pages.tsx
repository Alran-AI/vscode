import { useMemo, useRef, useState } from 'preact/hooks';

import type { PanelAction, PanelPage, PanelRow, PanelView } from '../../shared/panels';
import { post } from '../store';
import { DiffStatBadge } from './Diff';
import { Icon } from './Transcript';

/** What the Chat tab shows about the conversations: nothing, working, or waiting for the person. */
export type ChatActivity = 'idle' | 'working' | 'waiting';

interface NavEntry {
  readonly page: PanelPage | 'chat';
  readonly label: string;
  readonly icon: string;
}

const NAV: readonly NavEntry[] = [
  { page: 'chat', label: 'Chat', icon: 'comment-discussion' },
  { page: 'sessions', label: 'Sessions', icon: 'history' },
  { page: 'changes', label: 'Changes', icon: 'diff' },
  { page: 'agents', label: 'Agents', icon: 'organization' },
  { page: 'capabilities', label: 'Capabilities', icon: 'extensions' },
  { page: 'account', label: 'Account', icon: 'account' },
];

/** The way between the chat and the pages next to it. Icons only when the bar is narrow. */
export function PageNav({
  page,
  badges,
  activity = 'idle',
  onOpen,
}: {
  readonly page: PanelPage | 'chat';
  readonly badges: { readonly changes: number; readonly agents: number };
  readonly activity?: ChatActivity;
  readonly onOpen: (page: PanelPage | 'chat') => void;
}) {
  const bar = useRef<HTMLElement>(null);
  // Arrow keys move between the tabs, Home and End jump to the ends; only the open tab is in the tab order.
  const onKeyDown = (event: KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const current = NAV.findIndex((entry) => entry.page === page);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? NAV.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + NAV.length) % NAV.length;
    const target = NAV[next];
    if (!target) return;
    event.preventDefault();
    onOpen(target.page);
    // Every tab is always in the bar, so focus can move at once; it follows the page that opened.
    bar.current?.querySelector<HTMLElement>(`[data-page="${target.page}"]`)?.focus();
  };
  return (
    <nav class="page-nav" role="tablist" aria-label="Alran Code" ref={bar} onKeyDown={onKeyDown}>
      {NAV.map((entry) => {
        const count = entry.page === 'changes' ? badges.changes : entry.page === 'agents' ? badges.agents : 0;
        const status = entry.page === 'chat' ? activity : 'idle';
        const hint =
          status === 'waiting' ? `${entry.label}: Alran is waiting for you` : status === 'working' ? `${entry.label}: Alran is working` : entry.label;
        return (
          <button
            key={entry.page}
            data-page={entry.page}
            class={`nav-button${entry.page === page ? ' active' : ''}`}
            role="tab"
            aria-selected={entry.page === page}
            tabIndex={entry.page === page ? 0 : -1}
            title={hint}
            aria-label={hint}
            onClick={() => onOpen(entry.page)}
          >
            <Icon name={entry.icon} />
            <span class="nav-label">{entry.label}</span>
            {status !== 'idle' ? <span class={`nav-dot ${status}`} aria-hidden="true" /> : null}
            {count > 0 ? <span class="nav-badge">{count > 99 ? '99+' : count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

function iconName(icon: string | undefined, fallback: string): { name: string; spin: boolean } {
  const raw = icon ?? fallback;
  return raw.endsWith('~spin') ? { name: raw.slice(0, -5), spin: true } : { name: raw, spin: false };
}

function ActionButtons({
  actions,
  onRun,
}: {
  readonly actions: readonly PanelAction[];
  readonly onRun: (action: PanelAction) => void;
}) {
  return (
    <>
      {actions.map((action) => (
        <button
          key={action.id}
          class="icon-button"
          title={action.label}
          aria-label={action.label}
          onClick={(event) => {
            event.stopPropagation();
            onRun(action);
          }}
        >
          <Icon name={action.icon} />
        </button>
      ))}
    </>
  );
}

function Row({
  row,
  page,
  depth,
  forceOpen,
}: {
  readonly row: PanelRow;
  readonly page: PanelPage;
  readonly depth: number;
  /** A filter is typed: every group opens so a match is never hidden in a closed one. */
  readonly forceOpen: boolean;
}) {
  const hasChildren = (row.children?.length ?? 0) > 0;
  const [openState, setOpen] = useState(row.group === true);
  const open = openState || forceOpen;
  const fallback = page === 'changes' ? 'file' : 'circle-outline';
  const { name, spin } = iconName(row.icon, fallback);
  const activate = () => {
    if (row.clickable) post({ type: 'panelRow', rowId: row.id });
    else if (hasChildren) setOpen(!open);
  };
  if (row.note) {
    return (
      <div class="page-note" style={{ paddingLeft: `${String(12 + depth * 14)}px` }}>
        <Icon name={name} /> {row.label}
      </div>
    );
  }
  return (
    <>
      <div
        class={`page-row${row.clickable || hasChildren ? ' interactive' : ''}${row.group ? ' group' : ''}`}
        style={{ paddingLeft: `${String(8 + depth * 14)}px` }}
        title={row.tooltip ?? (row.description ? `${row.label}: ${row.description}` : row.label)}
      >
        {hasChildren ? (
          <button
            class="row-twisty"
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          </button>
        ) : (
          <span class="row-twisty" />
        )}
        <button class="row-main" onClick={activate} disabled={!row.clickable && !hasChildren}>
          <Icon name={name} spin={spin} />
          <span class="row-label">{row.label}</span>
          {row.description ? <span class="row-description">{row.description}</span> : null}
          {row.stat ? <DiffStatBadge stat={row.stat} className="row-stat" /> : null}
          {row.group && hasChildren ? <span class="row-count">{row.children?.length}</span> : null}
        </button>
        <span class="row-actions">
          <ActionButtons actions={row.actions} onRun={(action) => post({ type: 'panelRow', rowId: row.id, actionId: action.id })} />
        </span>
      </div>
      {hasChildren && open
        ? row.children?.map((child) => <Row key={child.id} row={child} page={page} depth={depth + 1} forceOpen={forceOpen} />)
        : null}
    </>
  );
}

const PAGE_ICONS: Readonly<Record<PanelPage, string>> = {
  sessions: 'history',
  changes: 'diff',
  agents: 'organization',
  capabilities: 'extensions',
  account: 'account',
};

/** A filter box is worth its space once a list page has more than this many rows. */
const FILTER_THRESHOLD = 8;

/** Pages that are a list that grows. The account and the sub-agents are a few fixed rows: no count, no filter. */
const LISTS: ReadonlySet<PanelPage> = new Set<PanelPage>(['sessions', 'changes', 'capabilities']);
const COUNTED: ReadonlySet<PanelPage> = new Set<PanelPage>(['sessions', 'changes']);

/** The items on a page: a group heading is not one, only what is inside it. */
function countRows(rows: readonly PanelRow[]): number {
  return rows.reduce(
    (total, row) => total + (row.children && row.children.length > 0 ? countRows(row.children) : row.note ? 0 : 1),
    0,
  );
}

function matches(row: PanelRow, needle: string): boolean {
  return `${row.label} ${row.description ?? ''}`.toLowerCase().includes(needle);
}

/** The rows that match, with the groups that lead to them; a matching group keeps all of its rows. */
function filterRows(rows: readonly PanelRow[], needle: string): PanelRow[] {
  const kept: PanelRow[] = [];
  for (const row of rows) {
    if (row.note) continue;
    if (matches(row, needle)) {
      kept.push(row);
      continue;
    }
    const children = filterRows(row.children ?? [], needle);
    if (children.length > 0) kept.push({ ...row, children });
  }
  return kept;
}

/** Up and down move between the rows, right opens a group and left closes it, like a tree. */
function onRowKeys(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (!target.closest('.row-main, .row-twisty')) return;
  const container = event.currentTarget as HTMLElement;
  const stops = [...container.querySelectorAll<HTMLElement>('.row-main:not(:disabled)')];
  const index = stops.indexOf(target.closest<HTMLElement>('.row-main') ?? target);
  const focus = (position: number) => {
    event.preventDefault();
    stops[Math.max(0, Math.min(stops.length - 1, position))]?.focus();
  };
  if (event.key === 'ArrowDown') focus(index + 1);
  else if (event.key === 'ArrowUp') focus(index - 1);
  else if (event.key === 'Home') focus(0);
  else if (event.key === 'End') focus(stops.length - 1);
  else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    const twisty = target.closest('.page-row')?.querySelector<HTMLElement>('button.row-twisty');
    if (!twisty) return;
    const expanded = twisty.getAttribute('aria-expanded') === 'true';
    if ((event.key === 'ArrowRight') === !expanded) {
      event.preventDefault();
      twisty.click();
    }
  }
}

function Skeleton() {
  return (
    <div class="skeleton" aria-busy="true" aria-label="Loading">
      {[72, 55, 64, 40].map((width) => (
        <div key={width} class="skeleton-row">
          <span class="skeleton-icon" />
          <span class="skeleton-bar" style={{ width: `${String(width)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** One page next to the chat: a header with its buttons, and its rows. */
export function PagePanel({ page, view }: { readonly page: PanelPage; readonly view: PanelView | undefined }) {
  const title = NAV.find((entry) => entry.page === page)?.label ?? page;
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const total = useMemo(() => (view ? countRows(view.rows) : 0), [view]);
  const rows = useMemo(() => (view && needle ? filterRows(view.rows, needle) : (view?.rows ?? [])), [view, needle]);
  const filterable = LISTS.has(page) && (total > FILTER_THRESHOLD || needle !== '');
  return (
    <section class="page" aria-label={title}>
      <div class="page-header">
        <h2>{view?.title ?? title}</h2>
        {view && total > 0 && COUNTED.has(page) ? <span class="page-count">{total}</span> : null}
        <span class="spacer" />
        {view ? (
          <ActionButtons actions={view.toolbar} onRun={(action) => post({ type: 'panelToolbar', actionId: action.id })} />
        ) : null}
      </div>
      {view && filterable ? (
        <div class="page-filter">
          <Icon name="search" />
          <input
            type="search"
            class="filter-input"
            placeholder={`Filter ${title.toLowerCase()}`}
            aria-label={`Filter ${title.toLowerCase()}`}
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
          />
          {query ? (
            <button class="icon-button" title="Clear the filter" aria-label="Clear the filter" onClick={() => setQuery('')}>
              <Icon name="close" />
            </button>
          ) : null}
        </div>
      ) : null}
      {!view ? (
        <Skeleton />
      ) : view.rows.length === 0 ? (
        <div class="empty page-empty">
          <div class="empty-mark" aria-hidden="true"><Icon name={PAGE_ICONS[page]} /></div>
          <p>{view.empty ?? 'Nothing here yet.'}</p>
          <div class="welcome-actions">
            {(view.emptyActions ?? []).map((action) => (
              <button
                key={action.id}
                class="button"
                onClick={() => post({ type: 'panelToolbar', actionId: action.id })}
              >
                <Icon name={action.icon} /> {action.label}
              </button>
            ))}
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div class="empty page-empty">
          <div class="empty-mark" aria-hidden="true"><Icon name="search" /></div>
          <p>Nothing matches “{query.trim()}”.</p>
          <button class="link-button" onClick={() => setQuery('')}>Clear the filter</button>
        </div>
      ) : (
        <div class="page-rows" role="group" aria-label={title} onKeyDown={onRowKeys}>
          {rows.map((row) => (
            <Row key={row.id} row={row} page={page} depth={0} forceOpen={needle !== ''} />
          ))}
        </div>
      )}
    </section>
  );
}
