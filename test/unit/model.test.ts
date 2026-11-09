import { describe, expect, it } from 'vitest';

import { cleanUserText, describeTool, parseToolOutput, SessionModel, stripSystemReminders } from '../../src/shared/model';
import type { SessionMeta, ToolItem } from '../../src/shared/types';

function createModel(): SessionModel {
  const meta: SessionMeta = {
    id: 's1',
    cwd: '/work',
    status: 'idle',
    modes: [],
    config: [],
    commands: [],
    delegation: [],
    queue: [],
    goalsEnabled: false,
    canRetry: false,
  };
  let now = 0;
  return new SessionModel(meta, { now: () => (now += 1) });
}

const text = (value: string) => ({ type: 'text' as const, text: value });

describe('SessionModel', () => {
  it('appends chunks of one message into a single item', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: text('Hel') });
    model.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: text('lo') });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
  });

  it('starts a new item after a tool call, even for the same message', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: text('before') });
    model.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', kind: 'read', status: 'pending' });
    model.apply({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: text('after') });
    expect(model.items.map((item) => item.kind)).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('merges tool updates and extracts the real patch', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'edit', kind: 'edit' });
    model.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      locations: [{ path: '/work/a.ts' }],
      rawInput: { file_path: '/work/a.ts' },
      rawOutput: {
        content: [text('Done.'), text('<system-reminder>\nhidden\n</system-reminder>')],
        details: { patch: '--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n' },
      },
    });
    const [tool] = model.items as ToolItem[];
    expect(tool).toMatchObject({ status: 'completed', output: 'Done.', locations: ['/work/a.ts'] });
    expect(tool?.patch).toContain('+y');
    expect(tool?.endedAt).toBeDefined();
  });

  it('nests tools under the running run_code program and honors the reported parent', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'tool_call', toolCallId: 'p', title: 'run_code', status: 'in_progress', name: 'run_code' } as never);
    model.apply({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'edit', status: 'in_progress', name: 'edit' } as never);
    expect((model.items[1] as ToolItem).parentId).toBe('p');
    model.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { details: { ptc_child: { record: { parent_tool_call_id: 'other' } } } },
    });
    expect((model.items[1] as ToolItem).parentId).toBe('other');
  });

  it('closes open tools only when asked', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'bash', status: 'in_progress' });
    model.settle({ closeTools: false });
    expect((model.items[0] as ToolItem).status).toBe('in_progress');
    model.settle({ closeTools: true });
    expect((model.items[0] as ToolItem).status).toBe('failed');
  });

  it('tracks markdown plans and their removal', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p1', content: '# Plan' } } as never);
    model.apply({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p1', content: '# Plan 2' } } as never);
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({ kind: 'plan', markdown: '# Plan 2' });
    model.apply({ sessionUpdate: 'plan_removed', planId: 'p1' } as never);
    expect(model.items[0]).toMatchObject({ removed: true });
  });

  it('keeps notices and permission decisions across a replay', () => {
    const model = createModel();
    const user = (id: string) => ({ sessionUpdate: 'user_message_chunk' as const, messageId: id, content: text(id) });
    model.apply(user('m1'));
    model.push({ kind: 'notice', id: 'n1', level: 'info', text: 'Stopped.', timestamp: 0 });
    model.apply(user('m2'));
    model.reset();
    expect(model.items).toEqual([]);
    model.apply(user('m1'));
    model.apply(user('m2'));
    model.restoreClientItems();
    expect(model.items.map((item) => item.kind)).toEqual(['user', 'notice', 'user']);
  });

  it('updates session metadata', () => {
    const model = createModel();
    model.apply({ sessionUpdate: 'session_info_update', title: 'Fix login' });
    model.apply({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.5, currency: 'USD' } });
    model.apply({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    model.apply({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Shorten', input: { hint: '[instructions]' } },
        { name: 'review', description: '[Skill] Review code' },
      ],
    });
    expect(model.meta).toMatchObject({
      title: 'Fix login',
      currentModeId: 'plan',
      usage: { used: 10, size: 100, costUsd: 0.5 },
    });
    expect(model.meta.commands).toEqual([
      { name: 'compact', description: 'Shorten', hint: '[instructions]', source: 'agent' },
      { name: 'review', description: 'Review code', source: 'skill' },
    ]);
  });
});

describe('text cleanup', () => {
  it('removes runtime reminders', () => {
    expect(stripSystemReminders('a<system-reminder>x</system-reminder>\nb')).toBe('ab');
  });

  it('reduces a questionnaire answer to its Q/A summary', () => {
    expect(
      cleanUserText('<questionnaire-response>\n<a/>\n</questionnaire-response>\n\nQ: Color?\nA: Blue'),
    ).toBe('Q: Color?\nA: Blue');
  });
});

describe('tool helpers', () => {
  it('describes tools from their input', () => {
    const base = { title: 'x', locations: [] as string[] };
    expect(describeTool({ ...base, name: 'edit', input: { file_path: '/a/b/c/d/e.ts' } })).toBe('Edit …/d/e.ts');
    expect(describeTool({ ...base, name: 'bash', input: { command: 'ls' } })).toBe('Run ls');
    expect(describeTool({ ...base, name: 'bash', input: { command: 'ls', description: 'List' } })).toBe('List');
    expect(describeTool({ ...base, name: 'run_code', input: { description: 'Batch' } })).toBe('Batch');
  });

  it('parses created files from a write result', () => {
    expect(parseToolOutput({ content: [], details: { created: true } }).created).toBe(true);
    expect(parseToolOutput('plain')).toEqual({ text: 'plain' });
  });
});
