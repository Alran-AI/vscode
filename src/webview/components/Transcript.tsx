import { memo } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { FailureAction, FailureView } from '../../shared/errors';
import { describeTool, isRecord } from '../../shared/model';
import type {
  NoticeItem,
  PermissionItem,
  PlanItem,
  QuestionField,
  QuestionItem,
  ThoughtItem,
  ToolItem,
  TranscriptItem,
  UserItem,
} from '../../shared/types';
import { post } from '../store';
import { PatchView, TextDiffView } from './Diff';
import { Markdown } from './Markdown';

export function Icon({ name, spin }: { readonly name: string; readonly spin?: boolean }) {
  return <i class={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />;
}

function UserMessage({ item }: { readonly item: UserItem }) {
  return (
    <div class={`message user${item.steered ? ' steered' : ''}`}>
      {item.steered ? <div class="message-tag">Steered into the running turn</div> : null}
      {item.content.map((part, index) => {
        if (part.type === 'text') return <div key={index} class="user-text">{part.text}</div>;
        if (part.type === 'image') {
          return <img key={index} class="user-image" alt="" src={`data:${part.mimeType};base64,${part.data}`} />;
        }
        return (
          <span key={index} class="chip" title={part.uri}>
            <Icon name="file" /> {part.name}
          </span>
        );
      })}
    </div>
  );
}

function AssistantMessage({
  text,
  streaming,
  plain,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly plain: boolean;
}) {
  return (
    <div class="message assistant">
      {plain ? <pre class="tool-pre plain-output">{text}</pre> : <Markdown text={text} />}
      {streaming ? <span class="cursor" /> : (
        <div class="message-actions">
          <button class="icon-button" title="Copy as Markdown" onClick={() => post({ type: 'copy', text })}>
            <Icon name="copy" />
          </button>
        </div>
      )}
    </div>
  );
}

function Thought({ item }: { readonly item: ThoughtItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="thought">
      <button class="row-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{item.streaming ? 'Thinking…' : 'Thought'}</span>
      </button>
      {open ? <div class="thought-text">{item.text}</div> : null}
    </div>
  );
}

const TOOL_ICONS: Readonly<Record<string, string>> = {
  read: 'eye',
  edit: 'edit',
  delete: 'trash',
  move: 'file-symlink-file',
  search: 'search',
  fetch: 'globe',
  think: 'lightbulb',
  execute: 'terminal',
  other: 'tools',
};

function statusIcon(status: ToolItem['status']) {
  if (status === 'completed') return <Icon name="check" />;
  if (status === 'failed') return <Icon name="error" />;
  return <Icon name="loading" spin />;
}

function inputPreview(item: ToolItem): string | undefined {
  if (!isRecord(item.input)) return undefined;
  if (typeof item.input.command === 'string') return item.input.command;
  if (typeof item.input.code === 'string') return item.input.code;
  if (item.toolKind === 'edit' || item.toolKind === 'read') return undefined;
  return JSON.stringify(item.input, null, 2);
}

function ToolRow({ item, children }: { readonly item: ToolItem; readonly children: readonly ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const preview = inputPreview(item);
  const failedChildren = children.filter((child) => child.status === 'failed').length;
  const hasDetail =
    preview !== undefined || !!item.output || !!item.patch || item.blocks.length > 0 || children.length > 0;
  return (
    <div class={`tool status-${item.status}`}>
      <button
        class="row-button tool-header"
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={open}
      >
        <Icon name={TOOL_ICONS[item.toolKind] ?? 'tools'} />
        <span class="tool-title">{describeTool(item)}</span>
        {children.length > 0 ? (
          <span class="tool-count">
            {children.length} calls{failedChildren ? `, ${String(failedChildren)} failed` : ''}
          </span>
        ) : null}
        <span class="tool-status">{statusIcon(item.status)}</span>
      </button>
      {open ? (
        <div class="tool-body">
          {preview !== undefined ? <pre class="tool-pre">{preview}</pre> : null}
          {item.patch ? <PatchView patch={item.patch} /> : null}
          {children.length > 0 ? (
            <div class="tool-children">
              {children.map((child) => (
                <ToolRow key={child.id} item={child} children={[]} />
              ))}
            </div>
          ) : null}
          {item.output && !item.patch ? <pre class="tool-pre tool-output">{item.output}</pre> : null}
          {item.locations.length > 0 ? (
            <div class="tool-actions">
              <button class="link-button" onClick={() => post({ type: 'openFile', path: item.locations[0] ?? '' })}>
                Open file
              </button>
              {item.toolKind === 'edit' ? (
                <button class="link-button" onClick={() => post({ type: 'openToolDiff', toolId: item.id })}>
                  Open diff
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PermissionPreview({ item }: { readonly item: PermissionItem }) {
  if (!isRecord(item.input)) return null;
  const { command, old_string: oldText, new_string: newText, content } = item.input;
  if (typeof command === 'string') return <pre class="tool-pre">{command}</pre>;
  if (typeof oldText === 'string' && typeof newText === 'string') {
    return <TextDiffView before={oldText} after={newText} />;
  }
  if (typeof content === 'string') {
    return <pre class="tool-pre">{content.length > 4000 ? `${content.slice(0, 4000)}…` : content}</pre>;
  }
  return <pre class="tool-pre">{JSON.stringify(item.input, null, 2)}</pre>;
}

function PermissionCard({ item }: { readonly item: PermissionItem }) {
  const buttonClass = (kind: string) =>
    kind.startsWith('allow') ? (kind === 'allow_once' ? 'button primary' : 'button') : 'button danger';
  return (
    <div class={`card permission${item.resolution ? ' resolved' : ''}`}>
      <div class="card-title">
        <Icon name="shield" /> {describeTool({ name: item.toolName ?? item.title, title: item.title, input: item.input, locations: item.locations })}
      </div>
      {item.locations.map((path) => (
        <button key={path} class="link-button card-path" onClick={() => post({ type: 'openFile', path })}>
          {path}
        </button>
      ))}
      <PermissionPreview item={item} />
      {item.resolution ? (
        <div class="card-resolution">{item.resolution}</div>
      ) : (
        <div class="card-actions">
          {item.options.map((option) => (
            <button
              key={option.id}
              class={buttonClass(option.kind)}
              onClick={() => post({ type: 'permission', id: item.id, optionId: option.id })}
            >
              {option.name}
            </button>
          ))}
          {item.toolKind === 'edit' ? (
            <button class="link-button" onClick={() => post({ type: 'previewPermissionDiff', id: item.id })}>
              Open diff
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function QuestionFieldView({
  field,
  values,
  onChange,
}: {
  readonly field: QuestionField;
  readonly values: Record<string, string | string[]>;
  readonly onChange: (id: string, value: string | string[]) => void;
}) {
  const current = values[field.id];
  const selected = Array.isArray(current) ? current : current ? [current] : [];
  return (
    <fieldset class="question-field">
      <legend>
        {field.title}
        {field.required ? <span class="required"> *</span> : null}
      </legend>
      {field.description ? <div class="question-description">{field.description}</div> : null}
      {field.type === 'text' ? (
        <textarea
          class="text-input"
          rows={2}
          value={typeof current === 'string' ? current : ''}
          onInput={(event) => onChange(field.id, (event.target as HTMLTextAreaElement).value)}
        />
      ) : (
        field.options.map((option) => (
          <label key={option.value} class="question-option">
            <input
              type={field.type === 'multiple' ? 'checkbox' : 'radio'}
              name={field.id}
              checked={selected.includes(option.value)}
              onChange={() => {
                if (field.type === 'multiple') {
                  onChange(
                    field.id,
                    selected.includes(option.value)
                      ? selected.filter((value) => value !== option.value)
                      : [...selected, option.value],
                  );
                } else {
                  onChange(field.id, option.value);
                  if (field.otherFieldId) onChange(field.otherFieldId, '');
                }
              }}
            />
            <span>
              {option.label}
              {option.description ? <span class="question-description"> — {option.description}</span> : null}
            </span>
          </label>
        ))
      )}
      {field.otherFieldId ? (
        <input
          class="text-input"
          placeholder="Other…"
          value={(values[field.otherFieldId] as string | undefined) ?? ''}
          onInput={(event) => {
            const text = (event.target as HTMLInputElement).value;
            onChange(field.otherFieldId ?? '', text);
            if (text && field.type === 'single') onChange(field.id, '');
          }}
        />
      ) : null}
    </fieldset>
  );
}

function QuestionCard({ item }: { readonly item: QuestionItem }) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const set = (id: string, value: string | string[]) => setValues((previous) => ({ ...previous, [id]: value }));
  const hasAnswer = (field: QuestionField) => {
    const value = values[field.id];
    const other = field.otherFieldId ? values[field.otherFieldId] : undefined;
    return (Array.isArray(value) ? value.length > 0 : !!value) || !!other;
  };
  const canSubmit = item.fields.every((field) => !field.required || hasAnswer(field));
  const submit = () => {
    const content = Object.fromEntries(
      Object.entries(values).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== '')),
    );
    post({ type: 'question', id: item.id, action: 'accept', content });
  };
  return (
    <div class={`card question${item.resolution ? ' resolved' : ''}`}>
      <div class="card-title">
        <Icon name="question" /> {item.message}
      </div>
      {item.resolution ? (
        <div class="card-resolution">{item.resolution}</div>
      ) : (
        <>
          {item.fields.map((field) => (
            <QuestionFieldView key={field.id} field={field} values={values} onChange={set} />
          ))}
          <div class="card-actions">
            <button class="button primary" disabled={!canSubmit} onClick={submit}>
              Submit
            </button>
            <button class="button" onClick={() => post({ type: 'question', id: item.id, action: 'decline' })}>
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PlanCard({ item }: { readonly item: PlanItem }) {
  if (item.removed) return null;
  return (
    <div class="card plan">
      <div class="card-title">
        <Icon name="checklist" /> Plan
        <button class="link-button card-title-action" onClick={() => post({ type: 'openPlan', id: item.id })}>
          Open
        </button>
      </div>
      {item.markdown ? <Markdown text={item.markdown} /> : null}
      {item.entries ? (
        <ul class="plan-entries">
          {item.entries.map((entry, index) => (
            <li key={index} class={`plan-entry status-${entry.status ?? 'pending'}`}>
              <Icon name={entry.status === 'completed' ? 'pass-filled' : entry.status === 'in_progress' ? 'loading' : 'circle-outline'} spin={entry.status === 'in_progress'} />
              {entry.content}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const ACTION_LABELS: Readonly<Record<FailureAction, readonly [string, string]>> = {
  retry: ['Try again', 'refresh'],
  'sign-in': ['Sign in', 'account'],
  'add-credits': ['Add credit', 'credit-card'],
  'show-usage': ['Show usage', 'graph'],
  'switch-model': ['Choose another model', 'hubot'],
  'use-werk': ['Switch to Ottili Werk', 'sparkle'],
  'provider-settings': ['Provider settings', 'server'],
  compact: ['Compact conversation', 'fold'],
  'new-session': ['New session', 'add'],
  'show-logs': ['Show logs', 'output'],
};

function FailureCard({ item, failure }: { readonly item: NoticeItem; readonly failure: FailureView }) {
  const [showRaw, setShowRaw] = useState(false);
  const [primary, ...secondary] = failure.actions;
  const button = (action: FailureAction, primaryButton: boolean) => {
    const [label, icon] = ACTION_LABELS[action];
    return (
      <button
        key={action}
        class={primaryButton ? 'button primary small' : 'button small'}
        onClick={() =>
          action === 'sign-in'
            ? post({ type: 'signIn' })
            : post({ type: 'failureAction', action })
        }
      >
        <Icon name={icon} /> {label}
      </button>
    );
  };
  return (
    <div class={`failure-card kind-${failure.kind}`} role="alert">
      <div class="failure-title">
        <Icon name={failure.kind === 'auth' ? 'account' : failure.kind === 'model-restricted' || failure.kind === 'credits' ? 'credit-card' : failure.kind === 'network' ? 'plug' : 'error'} />
        <span>{failure.title}</span>
      </div>
      {failure.detail ? <div class="failure-detail">{failure.detail}</div> : null}
      {failure.actions.length > 0 ? (
        <div class="failure-actions">
          {primary ? button(primary, true) : null}
          {secondary.map((action) => button(action, false))}
        </div>
      ) : null}
      {item.text && item.text !== failure.title ? (
        <div class="failure-raw">
          <button class="link-button" onClick={() => setShowRaw(!showRaw)} aria-expanded={showRaw}>
            {showRaw ? 'Hide details' : 'Details'}
          </button>
          {showRaw ? (
            <>
              <pre class="tool-pre">{item.text}</pre>
              <button class="link-button" onClick={() => post({ type: 'copy', text: item.text })}>Copy</button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Notice({ item }: { readonly item: NoticeItem }) {
  if (item.failure) return <FailureCard item={item} failure={item.failure} />;
  const icon = item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'info';
  return (
    <div class={`notice ${item.level}`}>
      <Icon name={icon} />
      <span class="notice-text">{item.text}</span>
      {item.retryable ? (
        <button class="link-button" onClick={() => post({ type: 'retry' })}>
          Retry
        </button>
      ) : null}
      {item.authRequired ? (
        <button class="link-button" onClick={() => post({ type: 'signIn' })}>
          Sign in
        </button>
      ) : null}
    </div>
  );
}

const TranscriptEntry = memo(function TranscriptEntry({
  item,
  childTools,
  showThinking,
}: {
  readonly item: TranscriptItem;
  readonly childTools: readonly ToolItem[];
  readonly showThinking: boolean;
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />;
    case 'assistant':
      return <AssistantMessage text={item.text} streaming={item.streaming} plain={item.plain === true} />;
    case 'thought':
      return showThinking ? <Thought item={item} /> : null;
    case 'tool':
      return <ToolRow item={item} children={childTools} />;
    case 'permission':
      return <PermissionCard item={item} />;
    case 'question':
      return <QuestionCard item={item} />;
    case 'plan':
      return <PlanCard item={item} />;
    case 'notice':
      return <Notice item={item} />;
  }
});

const NO_CHILDREN: readonly ToolItem[] = [];

export function Transcript({
  items,
  showThinking,
  busy,
}: {
  readonly items: readonly TranscriptItem[];
  readonly showThinking: boolean;
  readonly busy: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  const { topLevel, children } = useMemo(() => {
    const byParent = new Map<string, ToolItem[]>();
    for (const item of items) {
      if (item.kind === 'tool' && item.parentId) {
        const list = byParent.get(item.parentId) ?? [];
        list.push(item);
        byParent.set(item.parentId, list);
      }
    }
    const ids = new Set(items.map((item) => item.id));
    return {
      topLevel: items.filter((item) => !(item.kind === 'tool' && item.parentId && ids.has(item.parentId))),
      children: byParent,
    };
  }, [items]);

  useEffect(() => {
    const element = scroller.current;
    if (element && stuckToBottom.current) element.scrollTop = element.scrollHeight;
  });

  const onScroll = () => {
    const element = scroller.current;
    if (element) {
      stuckToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }
  };

  return (
    <div class="transcript" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
      {topLevel.map((item) => (
        <TranscriptEntry
          key={item.id}
          item={item}
          childTools={children.get(item.id) ?? NO_CHILDREN}
          showThinking={showThinking}
        />
      ))}
      {busy ? (
        <div class="working">
          <Icon name="loading" spin /> Working…
        </div>
      ) : null}
    </div>
  );
}
