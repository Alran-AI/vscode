import type { CommandView } from './types';

/**
 * Every TUI slash command that is not delivered by the agent through ACP. The
 * host implements each natively; commands the TUI alone can perform reopen the
 * current Session in the real TUI. See docs/feature-parity.md.
 */
export const CLIENT_COMMANDS: readonly CommandView[] = [
  { name: 'new', description: 'Start a fresh session in the current workspace', source: 'client' },
  { name: 'clear', description: 'Start a fresh session (alias of /new)', source: 'client' },
  { name: 'sessions', description: 'Search, resume, and manage sessions', hint: '[query]', source: 'client' },
  { name: 'resume', description: 'Resume a session (alias of /sessions)', hint: '[query]', source: 'client' },
  { name: 'fork', description: 'Fork this session into a new one', source: 'client' },
  { name: 'btw', description: 'Ask a side question without interrupting the running task', hint: '[question]', source: 'client' },
  { name: 'side', description: 'Ask a side question (alias of /btw)', hint: '[question]', source: 'client' },
  { name: 'parent', description: 'Return from a side conversation to its parent', source: 'client' },
  { name: 'goal', description: 'Start or manage the current Session Goal', hint: '<objective | pause | resume | edit | clear | budget=>', source: 'client' },
  { name: 'plan', description: 'Switch Plan Mode or view the latest Plan', hint: '[on | off | status | view]', source: 'client' },
  { name: 'review', description: 'Review staged, unstaged, and untracked local changes', source: 'client' },
  { name: 'init', description: 'Analyze the codebase and generate AGENTS.md', source: 'client' },
  { name: 'retry', description: 'Resend the last message after a failed response', source: 'client' },
  { name: 'steer', description: 'Steer current work without interrupting it', hint: '<message>', source: 'client' },
  { name: 'queue', description: 'Queue a message to run after the current response', hint: '<message>', source: 'client' },
  { name: 'stop', description: 'Interrupt the running turn', source: 'client' },
  { name: 'permission', description: 'Choose or inspect the permission mode', hint: '[status | ask | auto | full]', source: 'client' },
  { name: 'export', description: 'Export the current Session as Markdown', hint: '[path.md]', source: 'client' },
  { name: 'transcript', description: 'Browse and search the full conversation', source: 'client' },
  { name: 'copy', description: 'Copy last response as Markdown', source: 'client' },
  { name: 'tasks', description: 'Inspect background agents and Runtime tasks', source: 'client' },
  { name: 'provider', description: 'View providers and edit Alran credentials', source: 'client' },
  { name: 'plugins', description: 'Browse, install, enable, and remove Plugins', hint: '[filter]', source: 'client' },
  { name: 'login', description: 'Sign in to use Alran Code Agent features', source: 'client' },
  { name: 'logout', description: 'Sign out', source: 'client' },
  { name: 'update', description: 'Check for and install an Alran update', source: 'client' },
  { name: 'changelog', description: 'Show the packaged Alran update history', source: 'client' },
  { name: 'settings', description: 'Open Alran preferences (config.yaml and extension settings)', source: 'client' },
  { name: 'suggestions', description: 'Next-message suggestions (TUI only)', hint: '[on | off]', source: 'client' },
  { name: 'statusline', description: 'Configure the TUI status line (opens the TUI)', source: 'client' },
  { name: 'theme', description: 'Choose the TUI color theme (opens the TUI)', source: 'client' },
  { name: 'hotkeys', description: 'Open keyboard shortcuts', source: 'client' },
  { name: 'reload', description: 'Reload configuration and Plugins (restarts the agent)', source: 'client' },
  { name: 'feedback', description: 'Review and submit redacted product feedback (opens the TUI)', hint: '<message>', source: 'client' },
  { name: 'rewind', description: 'Rewind this Session (opens the TUI)', source: 'client' },
  { name: 'edit', description: 'Edit an earlier message (opens the TUI)', source: 'client' },
  { name: 'rename', description: 'Rename this Session (opens the TUI)', hint: '[title]', source: 'client' },
  { name: 'history', description: 'Browse Session history (opens the TUI)', source: 'client' },
  { name: 'add-dir', description: 'Add a workspace directory (opens the TUI)', hint: '<path>', source: 'client' },
  { name: 'mascot', description: 'Visit the little man who lives in the TUI', source: 'client' },
  { name: 'quit', description: 'Close this session tab', source: 'client' },
  { name: 'exit', description: 'Close this session tab (alias of /quit)', source: 'client' },
];

/** Commands the agent answers itself must keep working through ACP. */
export const AGENT_HANDLED_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'model',
  'status',
  'doctor',
  'context',
  'skills',
  'mcp',
  'usage',
  'compact',
]);

export interface SlashInvocation {
  readonly name: string;
  readonly args: string;
}

export function parseSlash(text: string): SlashInvocation | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*?))?\s*$/u.exec(text);
  if (!match?.[1]) return undefined;
  return { name: match[1], args: match[2]?.trim() ?? '' };
}

export function mergeCommands(agent: readonly CommandView[]): CommandView[] {
  const clientNames = new Set(CLIENT_COMMANDS.map((command) => command.name));
  const combined = [
    ...agent.filter((command) => !clientNames.has(command.name)),
    ...CLIENT_COMMANDS,
  ];
  return combined.sort((left, right) => {
    const rank = (command: CommandView) => (command.source === 'skill' ? 1 : 0);
    return rank(left) - rank(right) || left.name.localeCompare(right.name);
  });
}

/** `/goal` argument grammar from the TUI: an objective, an action, or `budget=`. */
export type GoalCommand =
  | { readonly action: 'show' }
  | { readonly action: 'pause' | 'resume' | 'clear' | 'help' }
  | { readonly action: 'edit'; readonly objective?: string }
  | { readonly action: 'budget'; readonly tokenBudget: number | null }
  | { readonly action: 'create'; readonly objective: string; readonly tokenBudget?: number };

export function parseGoalArgs(args: string): GoalCommand | { readonly error: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: 'show' };
  const [first = '', ...rest] = trimmed.split(/\s+/u);
  const lower = first.toLowerCase();
  if (lower === 'pause' || lower === 'resume' || lower === 'clear' || lower === 'help') {
    return { action: lower };
  }
  if (lower === 'edit') {
    const objective = rest.join(' ').trim();
    return objective ? { action: 'edit', objective } : { action: 'edit' };
  }
  if (lower.startsWith('budget=')) {
    const value = first.slice('budget='.length);
    if (value.toLowerCase() === 'clear') return { action: 'budget', tokenBudget: null };
    const tokens = parseTokenCount(value);
    return tokens === undefined
      ? { error: `Invalid token budget: ${value}. Use a value such as 50K, or budget=clear.` }
      : { action: 'budget', tokenBudget: tokens };
  }
  return { action: 'create', objective: trimmed };
}

export function parseTokenCount(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/u.exec(value.trim());
  if (!match?.[1]) return undefined;
  const scale = { '': 1, k: 1_000, m: 1_000_000 }[(match[2] ?? '').toLowerCase()] ?? 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}
