import { useEffect, useRef, useState } from 'preact/hooks';

import { describeStartupFailure } from '../shared/errors';
import type { AccountView, ConnectionState, GoalView, SessionMeta, TabView } from '../shared/types';
import { Composer } from './components/Composer';
import { AlranMark } from './components/Mark';
import { PageNav, PagePanel, type ChatActivity } from './components/Pages';
import { Icon, Transcript } from './components/Transcript';
import { composerEvents, openPage, post, useChatState } from './store';

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
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Opened from the keyboard or the mouse, the menu takes focus so the arrow keys work at once.
  useEffect(() => {
    if (menuOpen) menu.current?.querySelector<HTMLElement>('.menu-item')?.focus();
  }, [menuOpen]);
  const onMenuKeys = (event: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('.menu-item') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (position: number) => {
      event.preventDefault();
      items[(position + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      trigger.current?.focus();
    } else if (event.key === 'Tab') setMenuOpen(false);
  };
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
        <button ref={trigger} class="icon-button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name="ellipsis" />
        </button>
        {menuOpen ? (
          <div class="dropdown" role="menu" ref={menu} onKeyDown={onMenuKeys}>
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
    <div class={`goal-bar status-${goal.status}`} style={percent !== undefined ? { '--progress': `${String(percent)}%` } : undefined}>
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
      <button class="link-button" onClick={() => openPage('agents')}>Show</button>
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
        <AlranMark live size={36} />
        <span>Starting Alran Code…</span>
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
        <AlranMark size={44} />
        <h3>Connect Alran Code</h3>
        <p>Sign in with your Ottili account to use Ottili Werk and Claude models. New accounts get welcome credit for Werk; Claude runs on your own Anthropic key.</p>
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

interface Starter {
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
  /** A prompt for the composer, or a command to run. */
  readonly prompt?: string;
  readonly command?: string;
}

const STARTERS: readonly Starter[] = [
  { label: 'Review my changes', detail: 'Look over what is uncommitted', icon: 'git-pull-request', command: 'alran.reviewChanges' },
  {
    label: 'Explain this project',
    detail: 'A short tour of the code',
    icon: 'book',
    prompt: 'Give me a short tour of this project: what it does, how it is structured, and where to start reading.',
  },
  {
    label: 'Find and fix a bug',
    detail: 'Run the tests, fix what fails',
    icon: 'debug',
    prompt: 'Run the tests, find a failing or fragile spot, fix it and show me the change.',
  },
  {
    label: 'Write tests',
    detail: 'For the file you have open',
    icon: 'beaker',
    prompt: 'Write tests for the current file and make sure they pass.',
  },
  { label: 'Generate AGENTS.md', detail: 'Teach Alran this codebase', icon: 'file-text', command: 'alran.initProject' },
  { label: 'Resume a session', detail: 'Pick up where you left off', icon: 'history', command: 'alran.resumeSession' },
];

function Welcome({ account }: { readonly account: AccountView }) {
  return (
    <div class="empty welcome">
      <div class="welcome-mark"><AlranMark size={68} /></div>
      <h2>What should Alran build?</h2>
      <AccountLine account={account} />
      <div class="starters">
        {STARTERS.map((starter) => (
          <button
            key={starter.label}
            class="starter"
            onClick={() =>
              starter.command ? post({ type: 'command', command: starter.command }) : composerEvents.setDraft?.(starter.prompt ?? '')
            }
          >
            <Icon name={starter.icon} />
            <span class="starter-text">
              <span class="starter-label">{starter.label}</span>
              <span class="starter-detail">{starter.detail}</span>
            </span>
          </button>
        ))}
      </div>
      <p class="hint"><kbd>@</kbd> adds files and Plugins · <kbd>/</kbd> opens commands · <kbd>Shift+Tab</kbd> toggles Plan Mode</p>
    </div>
  );
}

/** Whether Alran is working in any session, or waits for an answer in one: the Chat tab shows it on every page. */
function chatActivity(tabs: readonly TabView[]): ChatActivity {
  if (tabs.some((tab) => tab.status === 'awaiting-input')) return 'waiting';
  if (tabs.some((tab) => tab.status === 'running' || tab.status === 'background' || tab.status === 'cancelling')) return 'working';
  return 'idle';
}

export function App() {
  const state = useChatState();
  const { connection, tabs, activeId, meta, items, preferences, activeFile, account, surface, page, panel, badges } = state;
  const status = meta?.status;
  const busy = status === 'running' || status === 'awaiting-input' || status === 'cancelling';
  const hasConversation = items.length > 0;
  const activity = chatActivity(tabs);
  // A conversation stays readable when the agent needs a sign-in; the banner asks for it.
  const blocked =
    connection.state === 'missing-binary' ||
    connection.state === 'error' ||
    (connection.state === 'auth-required' && !hasConversation) ||
    (connection.state === 'connecting' && !meta);
  if (page !== 'chat') {
    // The pages next to the chat. The composer is not shown: nothing here is a message.
    return (
      <div class="app">
        <PageNav page={page} badges={badges} activity={activity} onOpen={openPage} />
        <PagePanel key={page} page={page} view={panel?.page === page ? panel : undefined} />
      </div>
    );
  }
  return (
    <div class="app">
      <PageNav page={page} badges={badges} activity={activity} onOpen={openPage} />
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
          <Icon name={meta?.detachedBy === 'tui' ? 'terminal' : 'plug'} />
          {meta?.detachedBy === 'tui'
            ? ' This session is open in the terminal. It comes back here when you close it there.'
            : ' This session is not connected to the agent.'}
          <span class="spacer" />
          <button class="link-button" onClick={() => post({ type: 'command', command: 'alran.reconnectSession' })}>Reconnect</button>
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
        sessionId={activeId}
        meta={meta}
        preferences={preferences}
        {...(activeFile ? { activeFile } : {})}
        busy={busy}
        disabled={blocked && connection.state !== 'connecting'}
      />
    </div>
  );
}
