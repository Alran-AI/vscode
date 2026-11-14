import { useEffect, useState } from 'preact/hooks';

import { describeStartupFailure } from '../shared/errors';
import type { AccountView, ConnectionState, GoalView, SessionMeta, TabView } from '../shared/types';
import { Composer } from './components/Composer';
import { Icon, Transcript } from './components/Transcript';
import { composerEvents, post, useChatState } from './store';

const MENU_ACTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['Fork this session', 'repo-forked', 'alran.forkSession'],
  ['Ask a side question', 'comment', 'alran.sideQuestion'],
  ['Start a Goal…', 'target', 'alran.goalStart'],
  ['Review local changes', 'git-pull-request', 'alran.reviewChanges'],
  ['Compact conversation', 'fold', 'alran.compact'],
  ['-', '', 'sep-1'],
  ['Export as Markdown', 'export', 'alran.exportSession'],
  ['Open transcript', 'book', 'alran.showTranscript'],
  ['Open chat in editor', 'empty-window', 'alran.openInEditor'],
  ['Open session in TUI', 'terminal', 'alran.openTui'],
  ['More TUI commands…', 'terminal-tmux', 'alran.tuiCommand'],
  ['-', '', 'sep-2'],
  ['Account and credit', 'account', 'alran.accountUsage'],
  ['Model providers and Plugins', 'extensions', 'alran.capabilities.focus'],
  ['Reload agent', 'refresh', 'alran.restartAgent'],
  ['Settings', 'settings-gear', 'alran.openSettings'],
  ['Show logs', 'output', 'alran.showLogs'],
];

const STATUS_LABELS: Readonly<Record<TabView['status'], string>> = {
  loading: 'loading',
  idle: 'ready',
  running: 'working',
  cancelling: 'stopping',
  'awaiting-input': 'waiting for you',
  background: 'working in the background',
  detached: 'detached',
};

function statusDot(status: TabView['status']): string {
  if (status === 'awaiting-input') return 'dot attention';
  if (status === 'running' || status === 'background' || status === 'cancelling') return 'dot running';
  if (status === 'detached') return 'dot detached';
  return 'dot';
}

function Header({
  tabs,
  activeId,
  surface,
}: {
  readonly tabs: readonly TabView[];
  readonly activeId?: string;
  readonly surface: 'sidebar' | 'panel';
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && (event.target as HTMLElement).closest('.menu-anchor')) return;
      setMenuOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('mousedown', close);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('mousedown', close);
    };
  }, [menuOpen]);
  return (
    <header class="header">
      <div class="tabs" role="tablist" aria-label="Sessions">
        {tabs.map((tab) => (
          <div key={tab.id} class={`tab${tab.id === activeId ? ' active' : ''}${tab.isSide ? ' side' : ''}`} role="tab" aria-selected={tab.id === activeId}>
            <button class="tab-label" title={`${tab.title} · ${STATUS_LABELS[tab.status]}`} onClick={() => post({ type: 'activateTab', id: tab.id })}>
              <span class={statusDot(tab.status)} />
              {tab.isSide ? <Icon name="comment" /> : null}
              <span class="tab-title">{tab.title}</span>
            </button>
            <button class="tab-close" title="Close session tab" aria-label={`Close ${tab.title}`} onClick={() => post({ type: 'closeTab', id: tab.id })}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
      {surface === 'panel' ? (
        <>
          <button class="icon-button" title="New session" aria-label="New session" onClick={() => post({ type: 'newSession' })}>
            <Icon name="add" />
          </button>
          <button class="icon-button" title="Resume a session" aria-label="Resume a session" onClick={() => post({ type: 'command', command: 'alran.resumeSession' })}>
            <Icon name="history" />
          </button>
        </>
      ) : null}
      <div class="menu-anchor">
        <button class="icon-button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name="ellipsis" />
        </button>
        {menuOpen ? (
          <div class="dropdown" role="menu">
            {MENU_ACTIONS.map(([label, icon, command]) =>
              label === '-' ? (
                <div key={command} class="menu-separator" role="separator" />
              ) : (
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
              ),
            )}
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

function SignInOptions() {
  return (
    <div class="signin-options">
      <button class="button primary wide" onClick={() => post({ type: 'signIn' })}>
        <Icon name="account" /> Sign in with Ottili
      </button>
      <div class="link-row">
        <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.loginWithDeviceCode' })}>Sign in with a code</button>
        <span aria-hidden="true">·</span>
        <button class="link-button" onClick={() => post({ type: 'signIn', method: 'api-key' })}>Use an API key</button>
      </div>
      <button class="link-button" onClick={() => post({ type: 'signIn', method: 'provider' })}>
        Use your own model provider instead
      </button>
    </div>
  );
}

function ConnectionCard({ connection }: { readonly connection: ConnectionState }) {
  if (connection.state === 'connecting') {
    return (
      <div class="empty" aria-busy="true">
        <Icon name="loading" spin /> Starting Alran Code…
      </div>
    );
  }
  if (connection.state === 'missing-binary') {
    return (
      <div class="empty card-center">
        <Icon name="cloud-download" />
        <h3>Install the Alran CLI</h3>
        <p>The extension runs the <code>alran</code> command on this computer. It takes about a minute to install.</p>
        <button class="button primary wide" onClick={() => post({ type: 'command', command: 'alran.installCli' })}>
          <Icon name="cloud-download" /> Install Alran
        </button>
        <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.restartAgent' })}>I installed it, try again</button>
      </div>
    );
  }
  if (connection.state === 'auth-required') {
    return (
      <div class="empty card-center">
        <Icon name="sparkle" />
        <h3>Connect Alran Code</h3>
        <p>Sign in with your Ottili account to use Ottili Werk and Claude models. New accounts get welcome credit for Werk.</p>
        <SignInOptions />
      </div>
    );
  }
  if (connection.state === 'error') {
    const failure = describeStartupFailure(connection.detail);
    return (
      <div class="empty card-center">
        <Icon name="error" />
        <h3>{failure.title}</h3>
        <p>{failure.detail}</p>
        <div class="welcome-actions">
          <button class="button primary" onClick={() => post({ type: 'command', command: 'alran.restartAgent' })}>
            <Icon name="refresh" /> Try again
          </button>
          {failure.hint === 'node' ? (
            <button class="button" onClick={() => post({ type: 'command', command: 'alran.openSettings' })}>
              <Icon name="settings-gear" /> Choose Node.js…
            </button>
          ) : null}
          {failure.hint === 'reinstall' ? (
            <button class="button" onClick={() => post({ type: 'command', command: 'alran.installCli' })}>
              <Icon name="cloud-download" /> Reinstall the CLI
            </button>
          ) : null}
          <button class="button" onClick={() => post({ type: 'command', command: 'alran.showLogs' })}>
            <Icon name="output" /> Show logs
          </button>
        </div>
        <details class="startup-detail">
          <summary>Details</summary>
          <pre class="tool-pre">{connection.detail}</pre>
        </details>
      </div>
    );
  }
  return null;
}

function AccountLine({ account }: { readonly account: AccountView }) {
  if (account.state === 'signed-in') {
    return (
      <button class={`account-line${account.lowCredit ? ' low' : ''}`} title="Account and credit" onClick={() => post({ type: 'command', command: 'alran.accountUsage' })}>
        <Icon name="account" /> {account.name}
        {account.credit ? (
          <span class="account-credit">
            · {account.credit} credit{account.lowCredit ? ' — add more' : ''}
          </span>
        ) : null}
      </button>
    );
  }
  if (account.state === 'api-key') {
    return (
      <span class="account-line">
        <Icon name="key" /> Ottili API key{account.label ? ` ${account.label}` : ''}
      </span>
    );
  }
  if (account.state === 'provider') {
    return (
      <span class="account-line">
        <Icon name="server" /> {account.label ? `${account.label} · your provider` : 'Your own provider'}
      </span>
    );
  }
  if (account.state === 'signed-out') {
    return (
      <button class="account-line" onClick={() => post({ type: 'signIn', method: 'options' })}>
        <Icon name="account" /> Not signed in to Ottili
      </button>
    );
  }
  return null;
}

const SUGGESTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['Explain this project', 'book', 'Give me a short tour of this project: what it does, how it is structured, and where to start reading.'],
  ['Find and fix a bug', 'debug', 'Run the tests, find a failing or fragile spot, fix it and show me the change.'],
  ['Write tests', 'beaker', 'Write tests for the current file and make sure they pass.'],
];

function Welcome({ account }: { readonly account: AccountView }) {
  return (
    <div class="empty welcome">
      <div class="welcome-mark" aria-hidden="true"><Icon name="sparkle" /></div>
      <h2>What should Alran build?</h2>
      <AccountLine account={account} />
      <div class="welcome-actions">
        <button class="button" onClick={() => post({ type: 'command', command: 'alran.reviewChanges' })}><Icon name="git-pull-request" /> Review my changes</button>
        {SUGGESTIONS.map(([label, icon, prompt]) => (
          <button key={label} class="button" onClick={() => composerEvents.setDraft?.(prompt)}><Icon name={icon} /> {label}</button>
        ))}
        <button class="button" onClick={() => post({ type: 'command', command: 'alran.initProject' })}><Icon name="file-text" /> Generate AGENTS.md</button>
        <button class="button" onClick={() => post({ type: 'command', command: 'alran.resumeSession' })}><Icon name="history" /> Resume a session</button>
      </div>
      <p class="hint"><kbd>@</kbd> adds files and Plugins · <kbd>/</kbd> opens commands · <kbd>Shift+Tab</kbd> toggles Plan Mode</p>
    </div>
  );
}

export function App() {
  const state = useChatState();
  const { connection, tabs, activeId, meta, items, preferences, activeFile, account, surface } = state;
  const status = meta?.status;
  const busy = status === 'running' || status === 'awaiting-input' || status === 'cancelling';
  const hasConversation = items.length > 0;
  // A conversation stays readable when the agent needs a sign-in; the banner asks for it.
  const blocked =
    connection.state === 'missing-binary' ||
    connection.state === 'error' ||
    (connection.state === 'auth-required' && !hasConversation) ||
    (connection.state === 'connecting' && !meta);
  return (
    <div class="app">
      <Header tabs={tabs} {...(activeId ? { activeId } : {})} surface={surface} />
      {meta?.goal ? <GoalBar goal={meta.goal} /> : null}
      {meta ? <DelegationBar meta={meta} /> : null}
      {connection.state === 'auth-required' && hasConversation ? (
        <div class="delegation-bar warning">
          <Icon name="account" /> Sign in to continue this session.
          <span class="spacer" />
          <button class="link-button" onClick={() => post({ type: 'signIn' })}>Sign in</button>
          <button class="link-button" onClick={() => post({ type: 'signIn', method: 'options' })}>Other options</button>
        </div>
      ) : null}
      {status === 'background' ? (
        <div class="delegation-bar"><Icon name="loading" spin /> Alran is working in the background. Output refreshes as it runs.</div>
      ) : null}
      {status === 'detached' && connection.state !== 'auth-required' ? (
        <div class="delegation-bar warning">
          <Icon name="plug" /> This session is not connected to the agent.
          <span class="spacer" />
          <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.restartAgent' })}>Reconnect</button>
        </div>
      ) : null}
      {blocked ? (
        <ConnectionCard connection={connection} />
      ) : !hasConversation ? (
        status === 'loading' ? (
          <div class="empty" aria-busy="true"><Icon name="loading" spin /> Loading the session…</div>
        ) : (
          <Welcome account={account} />
        )
      ) : (
        <Transcript items={items} showThinking={preferences.showThinking} busy={status === 'running'} />
      )}
      {meta ? <QueueList meta={meta} /> : null}
      <Composer
        key={activeId ?? 'none'}
        meta={meta}
        preferences={preferences}
        {...(activeFile ? { activeFile } : {})}
        busy={busy}
        disabled={blocked && connection.state !== 'connecting'}
      />
    </div>
  );
}
