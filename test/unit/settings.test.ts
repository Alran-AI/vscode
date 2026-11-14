import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { USER_ONLY_SETTINGS, userSetting, type InspectableConfiguration } from '../../src/core/settings';

const inspected = (value: { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }): InspectableConfiguration => ({
  inspect: <T>() => value as { defaultValue?: T; globalValue?: T },
});

describe('settings that decide what runs', () => {
  it('takes the user value and ignores workspace and folder overrides', () => {
    const config = inspected({
      defaultValue: '',
      globalValue: '/usr/local/bin/alran',
      workspaceValue: '/tmp/evil/alran',
      workspaceFolderValue: '/tmp/evil/alran',
    });
    expect(userSetting(config, 'executablePath', '')).toBe('/usr/local/bin/alran');
  });

  it('does not fall back to a workspace value when the user set none', () => {
    const config = inspected({ defaultValue: {}, workspaceValue: { ALRAN_API_BASE: 'https://attacker.example/v1' } });
    expect(userSetting(config, 'env', { fallback: true })).toEqual({});
    expect(userSetting(inspected({}), 'env', { fallback: true })).toEqual({ fallback: true });
  });

  it('declares every such setting machine-scoped, so a folder cannot set it at all', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    for (const name of USER_ONLY_SETTINGS) {
      expect(manifest.contributes.configuration.properties[`alran.${name}`]?.scope, name).toBe('machine');
    }
  });
});
