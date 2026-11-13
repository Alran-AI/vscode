import { describe, expect, it } from 'vitest';

import {
  formatMicroUsd,
  formatModelPrice,
  LoginOutputParser,
  modelKeyFromConfigValue,
  type DeviceCode,
} from '../../src/core/account';
import { AlranCliError, cliFailureMessage } from '../../src/core/cli';

describe('LoginOutputParser', () => {
  it('reads the browser sign-in URL, even split across chunks', () => {
    const urls: string[] = [];
    const parser = new LoginOutputParser({ onBrowserUrl: (url) => urls.push(url) });
    parser.push('Open this page to sign in with the Ottili Platform:\nhttps://platform.ottili.one/v2/auth/oidc/lo');
    parser.push('gin?return_to=http%3A%2F%2F127.0.0.1%3A18370%2Fcallback\n');
    expect(urls).toEqual([
      'https://platform.ottili.one/v2/auth/oidc/login?return_to=http%3A%2F%2F127.0.0.1%3A18370%2Fcallback',
    ]);
  });

  it('reads the device code instructions once', () => {
    const codes: DeviceCode[] = [];
    const parser = new LoginOutputParser({ onDeviceCode: (code) => codes.push(code) });
    const text = [
      '',
      'To sign in, open this page in a browser on any device:',
      '  https://ai.ottili.one/device',
      '',
      'and enter the code:  BCDF-GHJK',
      '',
      'or open it directly:  https://ai.ottili.one/device?user_code=BCDF-GHJK',
      '',
      'The code is valid for 10 minutes. Waiting for you to confirm… (Ctrl+C to cancel)',
      '',
    ].join('\n');
    parser.push(text.slice(0, 60));
    expect(codes).toEqual([]);
    parser.push(text.slice(60));
    parser.push('more output\n');
    expect(codes).toEqual([
      {
        userCode: 'BCDF-GHJK',
        verificationUri: 'https://ai.ottili.one/device',
        verificationUriComplete: 'https://ai.ottili.one/device?user_code=BCDF-GHJK',
        expiresInMinutes: 10,
      },
    ]);
  });
});

describe('formatting', () => {
  it('formats micro-USD like the CLI', () => {
    expect(formatMicroUsd(4_800_000)).toBe('$4.80');
    expect(formatMicroUsd(4_200)).toBe('$0.0042');
    expect(formatMicroUsd(undefined)).toBe('$0.00');
  });

  it('formats model prices with the service fee', () => {
    expect(formatModelPrice({ input: 500_000, output: 1_500_000, feeBps: 0 })).toBe('$0.50 / $1.50 per 1M tokens');
    expect(formatModelPrice({ input: 2_000_000, output: 10_000_000, feeBps: 450 })).toBe(
      '$2.00 / $10.00 per 1M tokens + 4.5 % fee',
    );
  });

  it('maps ACP model values to catalog keys', () => {
    expect(modelKeyFromConfigValue('m:alran:Alran-Werk:u')).toBe('alran/Alran-Werk');
    expect(modelKeyFromConfigValue('m:alran:anthropic%2Fclaude-sonnet-5.5:u')).toBe('alran/anthropic/claude-sonnet-5.5');
    expect(modelKeyFromConfigValue('m:custom_provider%3Afixture:fixture:v:high')).toBe('custom_provider:fixture/fixture');
    expect(modelKeyFromConfigValue('plain')).toBeUndefined();
  });
});

describe('CLI failures', () => {
  it('maps the account exit codes', () => {
    expect(new AlranCliError('x', { code: 2, stdout: '', stderr: '' }).kind).toBe('auth');
    expect(new AlranCliError('x', { code: 3, stdout: '', stderr: '' }).kind).toBe('rate-limit');
    expect(new AlranCliError('x', { code: 4, stdout: '', stderr: '' }).kind).toBe('offline');
    expect(new AlranCliError('x', { code: 5, stdout: '', stderr: '' }).kind).toBe('credits');
    expect(new AlranCliError('x', { code: 1, stdout: '', stderr: '' }).kind).toBe('error');
    expect(new AlranCliError('x', { code: null, stdout: '', stderr: '', timedOut: true }).kind).toBe('timeout');
  });

  it('keeps only the person-facing lines', () => {
    const message = cliFailureMessage(
      {
        code: 4,
        stdout: '',
        stderr:
          '(node:123) ExperimentalWarning: something\nThe Ottili Platform is not reachable (platform.ottili.one). Check your network connection and try again.\nUpdate available: 0.3.0 — run `alran update`\n',
      },
      ['usage'],
    );
    expect(message).toBe(
      'The Ottili Platform is not reachable (platform.ottili.one). Check your network connection and try again.',
    );
    expect(cliFailureMessage({ code: 1, stdout: '', stderr: '' }, ['usage'])).toBe('`alran usage` failed (exit code 1).');
  });
});
