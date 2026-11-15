import { describe, expect, it } from 'vitest';

import { formatTokensPerSecond, OutputRateTracker } from '../../src/shared/rate';

describe('OutputRateTracker', () => {
  it('says nothing until there is enough to say', () => {
    const tracker = new OutputRateTracker();
    expect(tracker.view(true)).toBeUndefined();
    tracker.add(40, 1_000);
    tracker.add(40, 1_100);
    expect(tracker.view(true)).toBeUndefined();
  });

  it('estimates four characters per token over the time text was flowing', () => {
    const tracker = new OutputRateTracker();
    // 20 chunks of 40 characters, 100 ms apart: 800 chars = 200 tokens over 1.9 s.
    for (let index = 0; index < 20; index += 1) tracker.add(40, 1_000 + index * 100);
    const view = tracker.view(true);
    expect(view?.estimated).toBe(true);
    expect(view?.live).toBe(true);
    expect(view?.tokensPerSecond).toBeCloseTo(200 / 1.9, 1);
  });

  it('does not count a pause (a tool running) as writing time', () => {
    const tracker = new OutputRateTracker();
    for (let index = 0; index < 10; index += 1) tracker.add(40, 1_000 + index * 100);
    tracker.add(40, 61_000); // a minute later: the model was waiting for a tool
    for (let index = 1; index < 10; index += 1) tracker.add(40, 61_000 + index * 100);
    const view = tracker.view(false);
    expect(view?.live).toBe(false);
    // 800 chars = 200 tokens over 1.8 s of streaming; a minute of waiting would give ~3 tok/s.
    expect(view?.tokensPerSecond).toBeGreaterThan(100);
  });

  it('starts afresh after a reset', () => {
    const tracker = new OutputRateTracker();
    for (let index = 0; index < 20; index += 1) tracker.add(40, 1_000 + index * 100);
    tracker.reset();
    expect(tracker.view(true)).toBeUndefined();
  });
});

describe('formatTokensPerSecond', () => {
  it('prints whole tokens from ten up and one decimal below', () => {
    expect(formatTokensPerSecond(202.4)).toBe('202');
    expect(formatTokensPerSecond(9.46)).toBe('9.5');
    expect(formatTokensPerSecond(10)).toBe('10');
  });
});
