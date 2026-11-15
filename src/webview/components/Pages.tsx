import { useState } from 'preact/hooks';

import type { PanelAction, PanelPage, PanelRow, PanelView } from '../../shared/panels';
import { post } from '../store';
import { Icon } from './Transcript';

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
  onOpen,
}: {
  readonly page: PanelPage | 'chat';
  readonly badges: { readonly changes: number; readonly agents: number };
  readonly onOpen: (page: PanelPage | 'chat') => void;
}) {
  return (
    <nav class="page-nav" role="tablist" aria-label="Alran Code">
      {NAV.map((entry) => {
        const count = entry.page === 'changes' ? badges.changes : entry.page === 'agents' ? badges.agents : 0;
        return (
          <button
            key={entry.page}
            class={`nav-button${entry.page === page ? ' active' : ''}`}
            role="tab"
            aria-selected={entry.page === page}
            title={entry.label}
            onClick={() => onOpen(entry.page)}
          >
            <Icon name={entry.icon} />
            <span class="nav-label">{entry.label}</span>
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
}: {
  readonly row: PanelRow;
  readonly page: PanelPage;
  readonly depth: number;
}) {
  const hasChildren = (row.children?.length ?? 0) > 0;
  const [open, setOpen] = useState(row.group === true);
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
        </button>
        <span class="row-actions">
          <ActionButtons actions={row.actions} onRun={(action) => post({ type: 'panelRow', rowId: row.id, actionId: action.id })} />
        </span>
      </div>
      {hasChildren && open
        ? row.children?.map((child) => <Row key={child.id} row={child} page={page} depth={depth + 1} />)
        : null}
    </>
  );
}

/** One page next to the chat: a header with its buttons, and its rows. */
export function PagePanel({ page, view }: { readonly page: PanelPage; readonly view: PanelView | undefined }) {
  const title = NAV.find((entry) => entry.page === page)?.label ?? page;
  return (
    <section class="page" aria-label={title}>
      <div class="page-header">
        <h2>{view?.title ?? title}</h2>
        <span class="spacer" />
        {view ? (
          <ActionButtons actions={view.toolbar} onRun={(action) => post({ type: 'panelToolbar', actionId: action.id })} />
        ) : null}
      </div>
      {!view ? (
        <div class="empty" aria-busy="true">
          <Icon name="loading" spin /> Loading…
        </div>
      ) : view.rows.length === 0 ? (
        <div class="empty page-empty">
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
      ) : (
        <div class="page-rows" role="tree">
          {view.rows.map((row) => (
            <Row key={row.id} row={row} page={page} depth={0} />
          ))}
        </div>
      )}
    </section>
  );
}
