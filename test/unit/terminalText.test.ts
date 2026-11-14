import { describe, expect, it } from 'vitest';

import { planTerminalText } from '../../src/core/terminalText';

describe('planTerminalText', () => {
  it('types a single-line command, trimmed, for the user to confirm with Enter', () => {
    expect(planTerminalText('npm test  \n')).toEqual({ kind: 'type', text: 'npm test' });
    expect(planTerminalText('git log --oneline | head -5')).toEqual({ kind: 'type', text: 'git log --oneline | head -5' });
  });

  it('never types a line break: the shell would run every line but the last', () => {
    for (const text of ['cd /tmp\nrm -rf build\nmake', 'a\r\nb', 'a\rb', 'echo 1 echo 2']) {
      expect(planTerminalText(text).kind, JSON.stringify(text)).toBe('paste');
    }
  });

  it('never types a control character: Tab completes, Escape and ^C act on the shell', () => {
    for (const text of ['l\ts', 'ls \u001b[A', 'ls \u0003', 'ls \u007f', 'ls \u0000']) {
      expect(planTerminalText(text).kind, JSON.stringify(text)).toBe('paste');
    }
  });

  it('has nothing to type for an empty block', () => {
    expect(planTerminalText(' \n\n')).toEqual({ kind: 'paste', text: '' });
  });
});
