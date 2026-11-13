import { describe, expect, it } from 'vitest';

import { describeFailure, describeStartupFailure, stripFailurePrefixes } from '../../src/shared/errors';

const byok = (detail: string) =>
  `Internal error: Alran Code Runtime failed: BYOK provider custom_provider:fixture upstream error: ${detail}`;

describe('describeFailure', () => {
  it('strips the runtime prefixes and names the provider', () => {
    expect(stripFailurePrefixes(byok('500 boom'))).toEqual({ text: '500 boom', provider: 'fixture' });
    expect(stripFailurePrefixes('Internal error: Alran Code Runtime failed: socket hang up')).toEqual({
      text: 'socket hang up',
    });
  });

  it('explains the welcome-credit restriction with Werk as the way out', () => {
    const view = describeFailure(
      'Internal error: Alran Code Runtime failed: 402 {"error":{"code":"free_credit_model_restricted","message":"Welcome credit covers Ottili Werk only."}}',
    );
    expect(view.kind).toBe('model-restricted');
    expect(view.actions).toEqual(['use-werk', 'add-credits']);
    expect(view.retryable).toBe(false);
  });

  it('separates exhausted Ottili credit from a provider without credit', () => {
    const ottili = describeFailure('Alran Code Runtime failed: 402 Payment Required');
    expect(ottili).toMatchObject({ kind: 'credits', actions: ['add-credits', 'show-usage'] });
    const provider = describeFailure(byok('402 insufficient balance'));
    expect(provider).toMatchObject({ kind: 'credits', provider: 'fixture' });
    expect(provider.actions).toContain('provider-settings');
  });

  it('asks for a sign-in on an ended Ottili session, and for the key on a provider', () => {
    expect(describeFailure('Alran Code Runtime failed: 401 Unauthorized')).toMatchObject({
      kind: 'auth',
      actions: ['sign-in', 'retry'],
    });
    expect(describeFailure(byok('401 The session has ended.'))).toMatchObject({
      kind: 'provider-auth',
      title: 'fixture rejected the API key',
    });
  });

  it('offers a retry for rate limits, outages and network errors', () => {
    expect(describeFailure(byok('429 Too many requests.'))).toMatchObject({ kind: 'rate-limit', retryable: true });
    expect(describeFailure(byok('500 The upstream model failed.'))).toMatchObject({
      kind: 'unavailable',
      retryable: true,
      status: 500,
    });
    expect(describeFailure('Alran Code Runtime failed: fetch failed (ECONNREFUSED)')).toMatchObject({
      kind: 'network',
      title: 'Cannot reach the Ottili AI Gateway',
    });
  });

  it('suggests compacting when the context is full', () => {
    expect(
      describeFailure(byok("400 This model's maximum context length is 32768 tokens.")),
    ).toMatchObject({ kind: 'context-limit', actions: ['compact', 'new-session'] });
  });

  it('keeps the reason of an unknown failure readable', () => {
    const view = describeFailure('Internal error: Alran Code Runtime failed: something odd happened');
    expect(view).toMatchObject({ kind: 'unknown', detail: 'something odd happened.', retryable: true });
  });
});

describe('describeStartupFailure', () => {
  it('recognises an old Node.js', () => {
    expect(describeStartupFailure('error: Alran Code requires Node.js 22.19 or newer').hint).toBe('node');
    expect(describeStartupFailure('SyntaxError: Unexpected token ?').hint).toBe('node');
  });

  it('recognises a broken installation', () => {
    expect(describeStartupFailure("Error: Cannot find module '/x/dist/cli.js'").hint).toBe('reinstall');
  });

  it('falls back to the last line', () => {
    expect(describeStartupFailure('line one\nfinal words').detail).toContain('final words');
  });
});
