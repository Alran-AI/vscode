import { useEffect, useState } from 'preact/hooks';

import type { PanelBadges, PanelPage, PanelView } from '../shared/panels';
import type { HostMessage, WebviewMessage } from '../shared/protocol';
import type {
  AccountView,
  ChatPreferences,
  ComposerAttachment,
  ConnectionState,
  MentionCandidate,
  SessionMeta,
  TabView,
  TranscriptItem,
} from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

export interface ChatState {
  connection: ConnectionState;
  tabs: readonly TabView[];
  activeId?: string;
  meta: SessionMeta | null;
  items: readonly TranscriptItem[];
  preferences: ChatPreferences;
  activeFile?: string;
  account: AccountView;
  /** `sidebar` for the view, `panel` for a chat opened in an editor tab. */
  surface: 'sidebar' | 'panel';
  /** Which page is showing: the chat, or one of the pages next to it. */
  page: PanelPage | 'chat';
  /** The data of the open page; a page that has not arrived yet shows as loading. */
  panel?: PanelView;
  badges: PanelBadges;
}

let state: ChatState = {
  connection: { state: 'disconnected' },
  tabs: [],
  meta: null,
  items: [],
  account: { state: 'unknown' },
  surface: document.body.dataset.surface === 'panel' ? 'panel' : 'sidebar',
  page: 'chat',
  badges: { changes: 0, agents: 0 },
  preferences: {
    enterWhileRunning: 'steer',
    showThinking: true,
    includeActiveFile: true,
    sendShortcut: 'enter',
  },
};

const listeners = new Set<() => void>();

/** Opens a page and tells the host, which keeps its data current while it stays open. */
export function openPage(page: PanelPage | 'chat'): void {
  update({ page, panel: page === 'chat' || state.panel?.page === page ? state.panel : undefined });
  post({ type: 'page', page });
}

function update(patch: Partial<ChatState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useChatState(): ChatState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

export interface ComposerEvents {
  addAttachments?(attachments: readonly ComposerAttachment[]): void;
  setDraft?(text: string, send?: boolean, menu?: boolean): void;
  focus?(): void;
  mentions?(requestId: number, candidates: readonly MentionCandidate[]): void;
}

export const composerEvents: ComposerEvents = {};

function upsertItems(sessionId: string, incoming: readonly TranscriptItem[]): void {
  if (sessionId !== state.activeId && sessionId !== state.meta?.id) return;
  const items = [...state.items];
  const index = new Map(items.map((item, position) => [item.id, position]));
  for (const item of incoming) {
    const position = index.get(item.id);
    if (position === undefined) {
      index.set(item.id, items.length);
      items.push(item);
    } else {
      items[position] = item;
    }
  }
  update({ items });
}

export function handleHostMessage(message: HostMessage): void {
  switch (message.type) {
    case 'connection':
      update({ connection: message.connection });
      break;
    case 'tabs':
      update({ tabs: message.tabs, activeId: message.activeId });
      break;
    case 'snapshot':
      update({ meta: message.snapshot?.meta ?? null, items: message.snapshot?.items ?? [] });
      break;
    case 'items':
      upsertItems(message.sessionId, message.items);
      break;
    case 'meta':
      update({ meta: message.meta });
      break;
    case 'preferences':
      update({ preferences: message.preferences });
      break;
    case 'activeFile':
      update({ activeFile: message.label });
      break;
    case 'mentions':
      composerEvents.mentions?.(message.requestId, message.candidates);
      break;
    case 'addAttachments':
      composerEvents.addAttachments?.(message.attachments);
      break;
    case 'setDraft':
      composerEvents.setDraft?.(message.text, message.send, message.menu);
      break;
    case 'focusComposer':
      composerEvents.focus?.();
      break;
    case 'account':
      update({ account: message.account });
      break;
    case 'panel':
      // A late answer for a page the person already left is dropped.
      if (message.view.page === state.page) update({ panel: message.view });
      break;
    case 'badges':
      update({ badges: message.badges });
      break;
    case 'showPage':
      openPage(message.page);
      break;
  }
}
