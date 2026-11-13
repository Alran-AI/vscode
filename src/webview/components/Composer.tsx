import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { mergeCommands } from '../../shared/commands';
import type {
  ChatPreferences,
  CommandView,
  ComposerAttachment,
  ConfigOptionView,
  MentionCandidate,
  SessionMeta,
} from '../../shared/types';
import { composerEvents, post } from '../store';
import { Icon } from './Transcript';

interface MenuEntry {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly icon: string;
  apply(): void;
}

const MAX_HISTORY = 100;
const IS_MAC = /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
let attachmentCounter = 0;

function newAttachmentId(): string {
  attachmentCounter += 1;
  return `local-${String(attachmentCounter)}`;
}

function attachmentIcon(attachment: ComposerAttachment): string {
  switch (attachment.kind) {
    case 'file':
      return 'file';
    case 'selection':
      return 'selection';
    case 'image':
      return 'file-media';
    case 'plugin':
      return 'extensions';
    case 'text':
      return 'note';
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path;
}

function uriToPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return undefined;
    const decoded = decodeURIComponent(url.pathname);
    return /^\/[a-zA-Z]:/u.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return undefined;
  }
}

function readImage(file: File): Promise<ComposerAttachment | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const [, data] = String(reader.result).split(',');
      resolve(
        data
          ? {
              kind: 'image',
              id: newAttachmentId(),
              label: file.name || 'Pasted image',
              mimeType: file.type,
              data,
            }
          : undefined,
      );
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

function ConfigSelect({ option, icon }: { readonly option: ConfigOptionView; readonly icon: string }) {
  return (
    <label class="config-select" title={option.description ?? option.name}>
      <Icon name={icon} />
      <select
        aria-label={option.name}
        value={option.currentValue}
        onChange={(event) => {
          const element = event.target as HTMLSelectElement;
          post({ type: 'setConfig', configId: option.id, value: element.value });
          // Controlled by the host: a declined change must not linger in the control.
          element.value = option.currentValue;
        }}
      >
        {option.options.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Composer({
  meta,
  preferences,
  activeFile,
  busy,
  disabled = false,
}: {
  readonly meta: SessionMeta | null;
  readonly preferences: ChatPreferences;
  readonly activeFile?: string;
  readonly busy: boolean;
  /** No agent to talk to yet (CLI missing, sign-in needed, startup failed). */
  readonly disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [includeActive, setIncludeActive] = useState(preferences.includeActiveFile);
  const [menuIndex, setMenuIndex] = useState(0);
  const [mentions, setMentions] = useState<readonly MentionCandidate[]>([]);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const mentionRequest = useRef(0);

  useEffect(() => setIncludeActive(preferences.includeActiveFile), [preferences.includeActiveFile]);

  const send = (value: string, alternate: boolean) => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    post({
      type: 'send',
      text: trimmed,
      attachments,
      includeActiveFile: includeActive && !!activeFile,
      ...(alternate ? { alternate: true } : {}),
    });
    if (trimmed) history.current = [trimmed, ...history.current].slice(0, MAX_HISTORY);
    historyIndex.current = null;
    setText('');
    setAttachments([]);
    setMenuDismissed(false);
  };

  // The host pushes drafts and attachments from editor commands.
  const latestSend = useRef(send);
  latestSend.current = send;
  useEffect(() => {
    composerEvents.addAttachments = (added) => setAttachments((previous) => [...previous, ...added]);
    composerEvents.setDraft = (draft, sendNow, menu) => {
      if (sendNow) latestSend.current(draft, false);
      else {
        setText(draft);
        setCursor(draft.length);
        setMenuIndex(0);
        // A draft from an editor command stays quiet unless it asks for the menu.
        setMenuDismissed(menu !== true);
        textarea.current?.focus();
      }
    };
    composerEvents.focus = () => textarea.current?.focus();
    composerEvents.mentions = (requestId, candidates) => {
      if (requestId === mentionRequest.current) {
        setMentions(candidates);
        setMenuIndex(0);
      }
    };
  }, []);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${String(Math.min(element.scrollHeight, 240))}px`;
  }, [text]);

  const before = text.slice(0, cursor);
  const slashQuery = !menuDismissed && /^\/[^\s]*$/u.test(text) ? text.slice(1).toLowerCase() : undefined;
  const mentionMatch = !menuDismissed ? /(?:^|\s)@([^\s]*)$/u.exec(before) : null;
  const mentionQuery = mentionMatch?.[1];

  useEffect(() => {
    if (mentionQuery === undefined) return;
    mentionRequest.current += 1;
    post({ type: 'mentionQuery', requestId: mentionRequest.current, query: mentionQuery });
  }, [mentionQuery]);

  const commands = useMemo(() => mergeCommands(meta?.commands ?? []), [meta?.commands]);

  const applyMention = (candidate: MentionCandidate) => {
    const start = before.lastIndexOf('@');
    const next = `${text.slice(0, start)}${text.slice(cursor)}`;
    setText(next);
    setCursor(start);
    setAttachments((previous) => [
      ...previous,
      candidate.kind === 'plugin'
        ? { kind: 'plugin', id: newAttachmentId(), label: candidate.label, pluginId: candidate.value }
        : {
            kind: 'file',
            id: newAttachmentId(),
            path: candidate.value,
            label: candidate.detail ?? candidate.label,
          },
    ]);
    textarea.current?.focus();
  };

  const applyCommand = (command: CommandView) => {
    setText(`/${command.name} `);
    setCursor(command.name.length + 2);
    setMenuDismissed(true);
    textarea.current?.focus();
  };

  const menu: readonly MenuEntry[] = useMemo(() => {
    if (slashQuery !== undefined) {
      return commands
        .filter((command) => command.name.toLowerCase().includes(slashQuery))
        .slice(0, 40)
        .map((command) => ({
          key: command.name,
          label: `/${command.name}${command.hint ? ` ${command.hint}` : ''}`,
          detail: command.description,
          icon: command.source === 'skill' ? 'wand' : 'symbol-event',
          apply: () => applyCommand(command),
        }));
    }
    if (mentionQuery !== undefined) {
      return mentions.map((candidate) => ({
        key: `${candidate.kind}:${candidate.value}`,
        label: candidate.label,
        ...(candidate.detail ? { detail: candidate.detail } : {}),
        icon: candidate.kind === 'plugin' ? 'extensions' : 'file',
        apply: () => applyMention(candidate),
      }));
    }
    return [];
  }, [slashQuery, mentionQuery, commands, mentions, text, cursor]);

  const menuOpen = menu.length > 0;
  const selected = Math.min(menuIndex, menu.length - 1);

  const onKeyDown = (event: KeyboardEvent) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMenuIndex((selected + 1) % menu.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((selected - 1 + menu.length) % menu.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        menu[selected]?.apply();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      post({ type: 'cycleMode' });
      return;
    }
    if (event.key.toLowerCase() === 'm' && event.altKey) {
      event.preventDefault();
      post({ type: 'cyclePermission' });
      return;
    }
    if (event.key === 'Escape' && busy) {
      event.preventDefault();
      post({ type: 'cancel' });
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      const modifier = event.ctrlKey || event.metaKey;
      const sends = preferences.sendShortcut === 'enter' || modifier;
      if (sends) {
        event.preventDefault();
        // With Enter as the send key, the modifier picks the other busy behaviour.
        send(text, preferences.sendShortcut === 'enter' && modifier);
      }
      return;
    }
    const element = event.target as HTMLTextAreaElement;
    if (event.key === 'ArrowUp' && element.selectionStart === 0 && history.current.length > 0) {
      if (text && historyIndex.current === null) return;
      event.preventDefault();
      const next = historyIndex.current === null ? 0 : Math.min(historyIndex.current + 1, history.current.length - 1);
      historyIndex.current = next;
      setText(history.current[next] ?? '');
      setMenuDismissed(true);
    } else if (event.key === 'ArrowDown' && historyIndex.current !== null) {
      event.preventDefault();
      const next = historyIndex.current - 1;
      historyIndex.current = next < 0 ? null : next;
      setText(next < 0 ? '' : (history.current[next] ?? ''));
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map(readImage)).then((images) => {
      const valid = images.filter((image): image is ComposerAttachment => image !== undefined);
      setAttachments((previous) => [...previous, ...valid]);
    });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const uris = (transfer.getData('text/uri-list') || transfer.getData('application/vnd.code.uri-list'))
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((uri) => uriToPath(uri) ?? []);
    if (uris.length > 0) {
      setAttachments((previous) => [
        ...previous,
        ...uris.map(
          (path): ComposerAttachment => ({ kind: 'file', id: newAttachmentId(), path, label: basename(path) }),
        ),
      ]);
      return;
    }
    const images = [...transfer.files].filter((file) => file.type.startsWith('image/'));
    void Promise.all(images.map(readImage)).then((read) => {
      const valid = read.filter((image): image is ComposerAttachment => image !== undefined);
      setAttachments((previous) => [...previous, ...valid]);
    });
  };

  const modelOption = meta?.config.find((option) => option.id === 'model');
  const effortOption = meta?.config.find((option) => option.id === 'thinkingEffort');
  const permissionOption = meta?.config.find((option) => option.id === 'permissionMode');
  const currentMode = meta?.pendingModeId ?? meta?.currentModeId;
  const usage = meta?.usage;
  const usagePercent = usage && usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : undefined;
  const busyAction = preferences.enterWhileRunning === 'steer' ? 'steer' : 'queue';
  const modifier = IS_MAC ? 'Cmd' : 'Ctrl';
  const placeholder = disabled
    ? 'Connect Alran Code above to start'
    : busy
      ? `Send to ${busyAction} the running task (${modifier}+Enter to ${busyAction === 'steer' ? 'queue' : 'steer'})`
      : preferences.sendShortcut === 'ctrlEnter'
        ? `Ask Alran. @ for context, / for commands, ${modifier}+Enter to send`
        : 'Ask Alran. @ for context, / for commands';

  return (
    <div class="composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
      {menuOpen ? (
        <div class="menu" role="listbox">
          {menu.map((entry, index) => (
            <button
              key={entry.key}
              class={`menu-item${index === selected ? ' selected' : ''}`}
              role="option"
              aria-selected={index === selected}
              onMouseDown={(event) => {
                event.preventDefault();
                entry.apply();
              }}
            >
              <Icon name={entry.icon} />
              <span class="menu-label">{entry.label}</span>
              {entry.detail ? <span class="menu-detail">{entry.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div class="composer-box">
        {attachments.length > 0 || (activeFile && includeActive) ? (
          <div class="chips">
            {activeFile && includeActive ? (
              <button class="chip chip-ghost" title="Current file is shared. Click to stop." onClick={() => setIncludeActive(false)}>
                <Icon name="eye" /> {basename(activeFile)}
              </button>
            ) : null}
            {attachments.map((attachment) => (
              <span class="chip" key={attachment.id}>
                <Icon name={attachmentIcon(attachment)} /> {attachment.label}
                <button
                  class="chip-remove"
                  title="Remove"
                  onClick={() => setAttachments((previous) => previous.filter((item) => item.id !== attachment.id))}
                >
                  <Icon name="close" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          class="composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Message Alran"
          onInput={(event) => {
            const element = event.target as HTMLTextAreaElement;
            setText(element.value);
            setCursor(element.selectionStart);
            setMenuDismissed(false);
            setMenuIndex(0);
            historyIndex.current = null;
          }}
          onKeyUp={(event) => setCursor((event.target as HTMLTextAreaElement).selectionStart)}
          onClick={(event) => setCursor((event.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div class="composer-footer">
          <button class="icon-button" title="Attach files or images" aria-label="Attach files or images" disabled={disabled} onClick={() => post({ type: 'pickAttachment' })}>
            <Icon name="add" />
          </button>
          {activeFile && !includeActive ? (
            <button class="icon-button" title="Share the current file" onClick={() => setIncludeActive(true)}>
              <Icon name="eye-closed" />
            </button>
          ) : null}
          {meta && meta.modes.length > 1 ? (
            <button
              class={`mode-toggle${currentMode === 'plan' ? ' active' : ''}`}
              title="Toggle Plan Mode (Shift+Tab)"
              onClick={() => post({ type: 'cycleMode' })}
            >
              <Icon name="checklist" /> Plan
              {meta.pendingModeId ? <span class="pending-dot" title="Applies to the next prompt" /> : null}
            </button>
          ) : null}
          {modelOption ? <ConfigSelect option={modelOption} icon="hubot" /> : null}
          {effortOption ? <ConfigSelect option={effortOption} icon="lightbulb" /> : null}
          {permissionOption ? <ConfigSelect option={permissionOption} icon="shield" /> : null}
          <span class="spacer" />
          {usagePercent !== undefined && usage ? (
            <span
              class={`context-meter${usagePercent >= 80 ? ' high' : ''}`}
              title={`${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} context tokens${usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(4)}` : ''}`}
            >
              {usagePercent}%
            </span>
          ) : null}
          {busy ? (
            <button class="icon-button stop" title="Stop (Esc)" aria-label="Stop" onClick={() => post({ type: 'cancel' })}>
              <Icon name="debug-stop" />
            </button>
          ) : null}
          <button
            class="icon-button send"
            title={busy ? `Send (${busyAction})` : 'Send'}
            aria-label="Send"
            disabled={disabled || (!text.trim() && attachments.length === 0)}
            onClick={() => send(text, false)}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
}
