import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_HANDLED_COMMANDS,
  CLIENT_COMMANDS,
  mergeCommands,
  parseGoalArgs,
  parseSlash,
  parseTokenCount,
} from '../../src/shared/commands';
import { toPromptBlocks, toQuestionFields, flattenForSteer } from '../../src/core/session';
import { parseMcpList } from '../../src/host/parseMcp';
import { hasSibling, readTuiCommands } from '../../scripts/tui-commands.mjs';

const root = path.resolve(__dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('slash parsing', () => {
  it('splits a command from its arguments', () => {
    expect(parseSlash('/goal ship it')).toEqual({ name: 'goal', args: 'ship it' });
    expect(parseSlash('/new')).toEqual({ name: 'new', args: '' });
    expect(parseSlash('/plugin:review now')).toEqual({ name: 'plugin:review', args: 'now' });
  });

  it('does not treat paths or prose as commands', () => {
    expect(parseSlash('/usr/bin/env is broken')).toBeUndefined();
    expect(parseSlash('hello /new')).toBeUndefined();
  });

  it('keeps agent commands and Skills, and lets client commands win', () => {
    const merged = mergeCommands([
      { name: 'compact', description: 'x', source: 'agent' },
      { name: 'new', description: 'agent version', source: 'agent' },
      { name: 'deploy', description: 'y', source: 'skill' },
    ]);
    expect(merged.find((command) => command.name === 'new')?.source).toBe('client');
    expect(merged.find((command) => command.name === 'compact')?.source).toBe('agent');
    expect(merged.at(-1)?.name).toBe('deploy');
  });
});

describe('TUI parity', () => {
  // Commands the user cannot invoke in the TUI, or that only answer a pending TUI prompt.
  const INTERNAL_TUI_COMMANDS = new Set(['archive', 'config', 'decision', 'allow', 'always', 'deny', 'permissions']);

  it('every public TUI slash command is available in the extension', () => {
    // A snapshot of the TUI's commands (`pnpm sync:tui` refreshes it), so this runs without alran-code.
    const snapshot = JSON.parse(read('test/fixtures/tui-commands.json')) as { names: string[]; aliases: string[] };
    const supported = new Set([...CLIENT_COMMANDS.map((command) => command.name), ...AGENT_HANDLED_COMMANDS]);
    const missing = [...snapshot.names, ...snapshot.aliases].filter(
      (name) => !supported.has(name) && !INTERNAL_TUI_COMMANDS.has(name),
    );
    expect(missing).toEqual([]);
  });

  it.skipIf(!hasSibling())('the snapshot matches the alran-code checkout next to this repository', () => {
    const snapshot = JSON.parse(read('test/fixtures/tui-commands.json')) as Record<string, unknown>;
    expect(snapshot).toEqual(readTuiCommands());
  });

  it('every client command has a handler', () => {
    const slash = read('src/host/slash.ts');
    const missing = CLIENT_COMMANDS.filter(
      (command) => command.name !== 'init' && !new RegExp(`['\\s]${command.name}'?:`, 'u').test(slash),
    );
    expect(missing.map((command) => command.name)).toEqual([]);
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(read('package.json')) as {
    contributes: { commands: Array<{ command: string }> };
  };
  const contributed = manifest.contributes.commands.map((entry) => entry.command).sort();
  const registered = [...read('src/host/commands.ts').matchAll(/'(alran\.[a-zA-Z]+)':/gu)]
    .map((match) => match[1] ?? '')
    .sort();

  it('contributes exactly the commands that are registered', () => {
    expect(contributed).toEqual(registered);
  });

  it('references only contributed commands in its menus', () => {
    const raw = read('package.json');
    const known = new Set(contributed);
    const used = [...raw.matchAll(/"command": "(alran\.[a-zA-Z]+)"/gu)].map((match) => match[1] ?? '');
    expect(used.filter((command) => !known.has(command))).toEqual([]);
  });
});

describe('goal arguments', () => {
  it('parses every TUI form', () => {
    expect(parseGoalArgs('')).toEqual({ action: 'show' });
    expect(parseGoalArgs('pause')).toEqual({ action: 'pause' });
    expect(parseGoalArgs('Ship the feature')).toEqual({ action: 'create', objective: 'Ship the feature' });
    expect(parseGoalArgs('budget=50K')).toEqual({ action: 'budget', tokenBudget: 50_000 });
    expect(parseGoalArgs('budget=clear')).toEqual({ action: 'budget', tokenBudget: null });
    expect(parseGoalArgs('edit new text')).toEqual({ action: 'edit', objective: 'new text' });
    expect(parseGoalArgs('budget=nope')).toHaveProperty('error');
  });

  it('parses token counts', () => {
    expect(parseTokenCount('2m')).toBe(2_000_000);
    expect(parseTokenCount('1.5k')).toBe(1_500);
    expect(parseTokenCount('0')).toBeUndefined();
  });
});

describe('prompt conversion', () => {
  const selection = {
    kind: 'selection' as const,
    id: '1',
    path: '/w/a.ts',
    label: 'a.ts:1-2',
    text: 'code',
    language: 'ts',
    startLine: 1,
    endLine: 2,
  };

  it('sends a bare slash command as one text block', () => {
    expect(toPromptBlocks({ text: '/compact now', attachments: [] })).toEqual([{ type: 'text', text: '/compact now' }]);
  });

  it('maps attachments to ACP blocks', () => {
    const blocks = toPromptBlocks({
      text: 'look',
      attachments: [
        { kind: 'file', id: '2', path: '/w/b file.ts', label: 'b file.ts' },
        selection,
        { kind: 'image', id: '3', label: 'p', mimeType: 'image/png', data: 'AAAA' },
        { kind: 'plugin', id: '4', label: 'Notes', pluginId: 'notes@local' },
      ],
    });
    expect(blocks[0]).toEqual({ type: 'text', text: '[@Notes](plugin://notes%40local) look' });
    expect(blocks[1]).toMatchObject({ type: 'resource_link', uri: 'file:///w/b%20file.ts' });
    expect(blocks[2]).toMatchObject({ type: 'text' });
    expect((blocks[2] as { text: string }).text).toContain('Selected lines 1-2 of /w/a.ts');
    expect(blocks[3]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('flattens text for steering and refuses images', () => {
    expect(flattenForSteer({ text: 'a', attachments: [selection] })).toContain('Selected lines');
    expect(
      flattenForSteer({ text: 'a', attachments: [{ kind: 'image', id: '1', label: 'x', mimeType: 'image/png', data: 'A' }] }),
    ).toBeUndefined();
  });
});

describe('questionnaire schema', () => {
  it('maps choices, multi-select, free text, and Other fields', () => {
    const fields = toQuestionFields({
      required: ['b'],
      properties: {
        a: { type: 'string', title: 'A?', oneOf: [{ const: 'a1', title: 'One', description: 'first' }] },
        a__other: { type: 'string', title: 'A? — Other' },
        b: { type: 'array', title: 'B?', items: { anyOf: [{ const: 'b1' }] } },
        c: { type: 'string', title: 'C?' },
      },
    });
    expect(fields.map((field) => [field.id, field.type, field.required])).toEqual([
      ['a', 'single', false],
      ['b', 'multiple', true],
      ['c', 'text', false],
    ]);
    expect(fields[0]?.otherFieldId).toBe('a__other');
    expect(fields[0]?.options[0]).toEqual({ value: 'a1', label: 'One', description: 'first' });
  });
});

describe('MCP list parsing', () => {
  it('reads the runtime format', () => {
    expect(
      parseMcpList('MCP servers · 2\n- github — enabled · stdio — Code hosting\n- old — disabled · http'),
    ).toEqual([
      { name: 'github', enabled: true, detail: 'stdio — Code hosting' },
      { name: 'old', enabled: false, detail: 'http' },
    ]);
  });
});
