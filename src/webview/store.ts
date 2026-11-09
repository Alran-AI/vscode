import { useEffect, useState } from 'preact/hooks';

import type { HostMessage, WebviewMessage } from '../shared/protocol';
import type {
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
}

let state: ChatState = {
  connection: { state: 'disconnected' },
  tabs: [],
  meta: null,
  items: [],
  preferences: {
    enterWhileRunning: 'steer',
    showThinking: true,
    includeActiveFile: true,
    sendShortcut: 'enter',
  },
};

const listeners = new Set<() => void>();

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
  setDraft?(text: string, send?: boolean): void;
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
      composerEvents.setDraft?.(message.text, message.send);
      break;
    case 'focusComposer':
      composerEvents.focus?.();
      break;
  }
}
