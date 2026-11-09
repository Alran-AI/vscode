import { useState } from 'preact/hooks';

import type { ConnectionState, GoalView, SessionMeta, TabView } from '../shared/types';
import { Composer } from './components/Composer';
import { Icon, Transcript } from './components/Transcript';
import { post, useChatState } from './store';

const MENU_ACTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['Fork this session', 'repo-forked', 'alran.forkSession'],
  ['Ask a side question', 'comment', 'alran.sideQuestion'],
  ['Review local changes', 'git-pull-request', 'alran.reviewChanges'],
  ['Compact conversation', 'fold', 'alran.compact'],
  ['Export as Markdown', 'export', 'alran.exportSession'],
  ['Open transcript', 'book', 'alran.showTranscript'],
  ['Open chat in editor', 'empty-window', 'alran.openInEditor'],
  ['Open session in TUI', 'terminal', 'alran.openTui'],
  ['More TUI commands…', 'terminal-tmux', 'alran.tuiCommand'],
  ['Reload agent', 'refresh', 'alran.restartAgent'],
  ['Settings', 'settings-gear', 'alran.openSettings'],
];

function statusDot(status: TabView['status']): string {
  if (status === 'awaiting-input') return 'dot attention';
  if (status === 'running' || status === 'background' || status === 'cancelling') return 'dot running';
  if (status === 'detached') return 'dot detached';
  return 'dot';
}

function Header({ tabs, activeId }: { readonly tabs: readonly TabView[]; readonly activeId?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header class="header">
      <div class="tabs" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.id} class={`tab${tab.id === activeId ? ' active' : ''}${tab.isSide ? ' side' : ''}`} role="tab" aria-selected={tab.id === activeId}>
            <button class="tab-label" title={tab.title} onClick={() => post({ type: 'activateTab', id: tab.id })}>
              <span class={statusDot(tab.status)} />
              {tab.isSide ? <Icon name="comment" /> : null}
              <span class="tab-title">{tab.title}</span>
            </button>
            <button class="tab-close" title="Close" onClick={() => post({ type: 'closeTab', id: tab.id })}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
      <button class="icon-button" title="New chat" onClick={() => post({ type: 'newSession' })}>
        <Icon name="add" />
      </button>
      <button class="icon-button" title="Resume a session" onClick={() => post({ type: 'command', command: 'alran.resumeSession' })}>
        <Icon name="history" />
      </button>
      <div class="menu-anchor">
        <button class="icon-button" title="More actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name="ellipsis" />
        </button>
        {menuOpen ? (
          <div class="dropdown" role="menu">
            {MENU_ACTIONS.map(([label, icon, command]) => (
              <button
                key={command}
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  post({ type: 'command', command });
                }}
              >
                <Icon name={icon} />
                <span class="menu-label">{label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function GoalBar({ goal }: { readonly goal: GoalView }) {
  const percent =
    goal.tokenBudget && goal.tokensUsed !== undefined
      ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100))
      : undefined;
  const paused = goal.status === 'paused' || goal.status === 'blocked';
  return (
    <div class={`goal-bar status-${goal.status}`}>
      <Icon name="target" />
      <span class="goal-objective" title={goal.objective}>{goal.objective}</span>
      <span class="goal-status">{goal.status.replace('_', ' ')}{percent !== undefined ? ` · ${String(percent)}%` : ''}</span>
      {goal.status === 'active' ? (
        <button class="icon-button" title="Pause Goal" onClick={() => post({ type: 'goal', operation: { op: 'pause' } })}>
          <Icon name="debug-pause" />
        </button>
      ) : null}
      {paused ? (
        <button class="icon-button" title="Resume Goal" onClick={() => post({ type: 'goal', operation: { op: 'resume' } })}>
          <Icon name="debug-start" />
        </button>
      ) : null}
      <button class="icon-button" title="Clear Goal" onClick={() => post({ type: 'goal', operation: { op: 'clear' } })}>
        <Icon name="close" />
      </button>
    </div>
  );
}

function DelegationBar({ meta }: { readonly meta: SessionMeta }) {
  const active = meta.delegation.filter((member) => member.status === 'running' || member.status === 'queued');
  if (active.length === 0) return null;
  return (
    <div class="delegation-bar">
      <Icon name="loading" spin />
      <span>{active.length} sub-agent{active.length === 1 ? '' : 's'} running</span>
      <span class="spacer" />
      <button class="link-button" onClick={() => post({ type: 'stopDelegation' })}>Stop all</button>
    </div>
  );
}

function QueueList({ meta }: { readonly meta: SessionMeta }) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (meta.queue.length === 0) return null;
  return (
    <div class="queue">
      <div class="queue-title">
        Queued ({meta.queue.length})
        <button class="link-button" onClick={() => post({ type: 'queue', operation: { op: 'clear' } })}>Clear</button>
      </div>
      {meta.queue.map((item) => (
        <div key={item.id} class="queue-item">
          {editing?.id === item.id ? (
            <input
              class="text-input"
              value={editing.text}
              onInput={(event) => setEditing({ id: item.id, text: (event.target as HTMLInputElement).value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  post({ type: 'queue', operation: { op: 'edit', id: item.id, text: editing.text } });
                  setEditing(null);
                } else if (event.key === 'Escape') setEditing(null);
              }}
            />
          ) : (
            <span class="queue-text" title={item.text}>{item.text}</span>
          )}
          <button class="icon-button" title="Edit" onClick={() => setEditing({ id: item.id, text: item.text })}><Icon name="edit" /></button>
          <button class="icon-button" title="Send now" onClick={() => post({ type: 'queue', operation: { op: 'steer', id: item.id } })}><Icon name="arrow-up" /></button>
          <button class="icon-button" title="Remove" onClick={() => post({ type: 'queue', operation: { op: 'delete', id: item.id } })}><Icon name="close" /></button>
        </div>
      ))}
    </div>
  );
}

function ConnectionCard({ connection }: { readonly connection: ConnectionState }) {
  if (connection.state === 'connecting') {
    return <div class="empty"><Icon name="loading" spin /> Starting Alran Code…</div>;
  }
  if (connection.state === 'missing-binary') {
    return (
      <div class="empty card-center">
        <Icon name="warning" />
        <h3>Alran Code CLI not found</h3>
        <p>The extension runs the <code>alran</code> command on this machine.</p>
        <button class="button primary" onClick={() => post({ type: 'command', command: 'alran.installCli' })}>Install or locate Alran</button>
        <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.restartAgent' })}>Try again</button>
      </div>
    );
  }
  if (connection.state === 'auth-required') {
    return (
      <div class="empty card-center">
        <Icon name="account" />
        <h3>Sign in to Alran Code</h3>
        <p>Connect your Ottili account, or add a model provider with your own API key.</p>
        <button class="button primary" onClick={() => post({ type: 'signIn' })}>Sign in</button>
        <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.providerAdd' })}>Add a provider instead</button>
      </div>
    );
  }
  if (connection.state === 'error') {
    return (
      <div class="empty card-center">
        <Icon name="error" />
        <h3>Could not start the agent</h3>
        <pre class="tool-pre">{connection.detail}</pre>
        <button class="button primary" onClick={() => post({ type: 'command', command: 'alran.restartAgent' })}>Try again</button>
        <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.showLogs' })}>Show logs</button>
      </div>
    );
  }
  return null;
}

function Welcome() {
  return (
    <div class="empty welcome">
      <h2>Alran Code</h2>
      <p>Describe a task, or try one of these.</p>
      <div class="welcome-actions">
        <button class="button" onClick={() => post({ type: 'command', command: 'alran.reviewChanges' })}><Icon name="git-pull-request" /> Review my changes</button>
        <button class="button" onClick={() => post({ type: 'command', command: 'alran.initProject' })}><Icon name="book" /> Generate AGENTS.md</button>
        <button class="button" onClick={() => post({ type: 'command', command: 'alran.resumeSession' })}><Icon name="history" /> Resume a session</button>
      </div>
      <p class="hint"><kbd>@</kbd> adds files and Plugins · <kbd>/</kbd> opens commands · <kbd>Shift+Tab</kbd> toggles Plan Mode</p>
    </div>
  );
}

export function App() {
  const state = useChatState();
  const { connection, tabs, activeId, meta, items, preferences, activeFile } = state;
  const status = meta?.status;
  const busy = status === 'running' || status === 'awaiting-input' || status === 'cancelling';
  const blocked =
    connection.state === 'missing-binary' ||
    connection.state === 'auth-required' ||
    connection.state === 'error' ||
    (connection.state === 'connecting' && !meta);
  return (
    <div class="app">
      <Header tabs={tabs} {...(activeId ? { activeId } : {})} />
      {meta?.goal ? <GoalBar goal={meta.goal} /> : null}
      {meta ? <DelegationBar meta={meta} /> : null}
      {status === 'background' ? (
        <div class="delegation-bar"><Icon name="loading" spin /> Alran is working in the background. Output refreshes as it runs.</div>
      ) : null}
      {status === 'detached' ? (
        <div class="delegation-bar warning"><Icon name="plug" /> This Session is detached.</div>
      ) : null}
      {blocked ? (
        <ConnectionCard connection={connection} />
      ) : items.length === 0 ? (
        <Welcome />
      ) : (
        <Transcript items={items} showThinking={preferences.showThinking} busy={status === 'running'} />
      )}
      {meta ? <QueueList meta={meta} /> : null}
      <Composer meta={meta} preferences={preferences} {...(activeFile ? { activeFile } : {})} busy={busy} />
    </div>
  );
}
