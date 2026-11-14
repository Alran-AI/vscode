import { describe, expect, it } from 'vitest';

import {
  groupLibrary,
  isBuiltIn,
  itemFromPluginInfo,
  itemFromSelector,
  itemState,
  parseApprovalRequest,
  primaryAction,
  storeSelector,
  type StoreItem,
} from '../../src/core/store';

function item(overrides: Partial<StoreItem> = {}): StoreItem {
  return {
    id: 'plugin:demo@ottili',
    kind: 'plugin',
    name: 'demo',
    displayName: 'Demo',
    origin: 'ottili',
    version: '1.0.0',
    description: 'A demo',
    installed: false,
    enabled: false,
    updateAvailable: false,
    summary: '',
    ...overrides,
  };
}

describe('approval request', () => {
  const refusal = [
    'Plugin hook-demo 1.0.0',
    '  This package will run commands or connect to services:',
    '    • Hook on SessionStart runs: bash "${PLUGIN_ROOT}/hooks/session-start"',
    '    • MCP server docs runs: npx docs-mcp',
    'hook-demo runs commands or connects to services (listed above). Nobody can be asked here: read the list and run again with --yes to approve it.',
  ].join('\n');

  it('lists what the plugin would run', () => {
    expect(parseApprovalRequest(refusal)).toEqual([
      'Hook on SessionStart runs: bash "${PLUGIN_ROOT}/hooks/session-start"',
      'MCP server docs runs: npx docs-mcp',
    ]);
  });

  it('is not an approval request for any other failure', () => {
    expect(parseApprovalRequest('error: store "ottili" could not be reached')).toBeUndefined();
    expect(parseApprovalRequest('')).toBeUndefined();
  });
});

describe('store rows', () => {
  it('selects with the store name so two stores offering one name stay apart', () => {
    expect(storeSelector(item())).toBe('demo@ottili');
    expect(storeSelector(item({ origin: '' }))).toBe('demo');
    expect(itemFromSelector('demo@acme')).toMatchObject({ name: 'demo', origin: 'acme', kind: 'plugin' });
    expect(itemFromSelector('a@b@c')).toMatchObject({ name: 'a@b', origin: 'c' });
    expect(itemFromSelector('plain', 'skill')).toMatchObject({ name: 'plain', origin: '', kind: 'skill' });
  });

  it('refuses a name the CLI would read as an option, or that carries whitespace or control characters', () => {
    expect(() => storeSelector(item({ name: '--yes', origin: '' }))).toThrow(/cannot be used safely/);
    expect(() => storeSelector(item({ name: '-x', origin: 'ottili' }))).toThrow(/cannot be used safely/);
    expect(() => storeSelector(item({ name: 'a b' }))).toThrow(/cannot be used safely/);
    expect(() => storeSelector(item({ name: 'a\nb' }))).toThrow(/cannot be used safely/);
    expect(() => storeSelector(item({ origin: 'x\ty' }))).toThrow(/cannot be used safely/);
  });

  it('chooses what Enter does', () => {
    expect(primaryAction(item())).toBe('install');
    expect(primaryAction(item({ installed: true, enabled: true }))).toBe('details');
    expect(primaryAction(item({ installed: true, enabled: true, updateAvailable: true }))).toBe('update');
    expect(primaryAction(item({ kind: 'skill', origin: 'built-in', installed: true }))).toBe('details');
    expect(isBuiltIn(item({ origin: 'built-in' }))).toBe(true);
  });

  it('says what state a row is in', () => {
    expect(itemState(item())).toBe('1.0.0');
    expect(itemState(item({ installed: true, enabled: true, installedVersion: '1.0.0' }))).toBe('Installed · 1.0.0');
    expect(itemState(item({ installed: true, enabled: false, installedVersion: '1.0.0' }))).toBe('Installed, off · 1.0.0');
    expect(itemState(item({ installed: true, enabled: true, installedVersion: '1.0.0', version: '1.1.0', updateAvailable: true }))).toBe(
      'Update available · 1.0.0 → 1.1.0',
    );
    expect(itemState(item({ kind: 'skill', origin: 'built-in', installed: true }))).toBe('Built in');
  });

  it('groups the library with built-in Skills last', () => {
    const groups = groupLibrary([
      item({ kind: 'skill', name: 'z', displayName: 'Zed', group: 'Built in', origin: 'built-in' }),
      item({ kind: 'skill', name: 'b', displayName: 'Beta', group: 'Redis' }),
      item({ kind: 'skill', name: 'a', displayName: 'Alpha', group: 'Redis' }),
      item({ kind: 'skill', name: 'c', displayName: 'Cee', group: 'Apollo' }),
      item({ kind: 'skill', name: 'n', displayName: 'None' }),
    ]);
    expect(groups.map((entry) => entry.group)).toEqual(['Apollo', 'Redis', 'Other', 'Built in']);
    expect(groups[1]?.items.map((entry) => entry.displayName)).toEqual(['Alpha', 'Beta']);
  });

  it('reads an installed Plugin from `plugin list`', () => {
    const row = itemFromPluginInfo({
      pluginId: 'resend-skills@ottili',
      name: 'resend-skills',
      displayName: 'Email (Resend)',
      marketplaceName: 'ottili',
      version: '1.0.0',
      enabled: false,
      installed: true,
      capabilities: { skillCount: 3, mcpServerCount: 1, appCount: 0 },
    });
    expect(row).toMatchObject({ origin: 'ottili', installed: true, enabled: false, summary: '3 skills · 1 MCP server' });
    expect(itemFromPluginInfo({ name: 'x', installed: false })).toMatchObject({ origin: 'local', installed: false, enabled: false });
  });
});
