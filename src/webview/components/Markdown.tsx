import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';
import { memo } from 'preact/compat';
import { useMemo } from 'preact/hooks';

import { post } from '../store';

const FILE_REFERENCE = /^(?:[\w@.-]+\/)*[\w@.-]+\.[a-zA-Z0-9]{1,8}(?::\d+)?$/u;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${String(char.charCodeAt(0))};`);
}

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').split(/\s+/u)[0] ?? '';
      const known = language && hljs.getLanguage(language);
      const highlighted = known
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text);
      const canRun = /^(bash|sh|shell|zsh|console)$/u.test(language);
      return `<div class="code-block" data-language="${escapeHtml(language)}"><div class="code-toolbar"><span class="code-language">${escapeHtml(language)}</span><button data-code-action="copy" title="Copy"><i class="codicon codicon-copy"></i></button><button data-code-action="insert" title="Insert at cursor"><i class="codicon codicon-insert"></i></button><button data-code-action="new-file" title="Open in new file"><i class="codicon codicon-new-file"></i></button>${canRun ? '<button data-code-action="run" title="Paste into terminal"><i class="codicon codicon-terminal"></i></button>' : ''}</div><pre><code class="hljs">${highlighted}</code></pre></div>`;
    },
    codespan({ text }: Tokens.Codespan): string {
      const decoded = text.replace(/&amp;/gu, '&');
      return FILE_REFERENCE.test(decoded)
        ? `<code class="file-link" data-file="${escapeHtml(decoded)}">${escapeHtml(decoded)}</code>`
        : `<code>${escapeHtml(decoded)}</code>`;
    },
  },
});

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['style', 'form', 'input', 'img'],
    ADD_ATTR: ['data-code-action', 'data-language', 'data-file'],
  });
}

function onContentClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLElement>('[data-code-action]');
  if (button) {
    const block = button.closest<HTMLElement>('.code-block');
    const code = block?.querySelector('code')?.textContent ?? '';
    const language = block?.dataset.language || undefined;
    const action = button.dataset.codeAction;
    if (action === 'copy') post({ type: 'copy', text: code });
    else if (action === 'insert') post({ type: 'insertAtCursor', text: code });
    else if (action === 'new-file') {
      post({ type: 'applyToNewFile', text: code, ...(language ? { language } : {}) });
    } else if (action === 'run') post({ type: 'runInTerminal', text: code.trimEnd() });
    return;
  }
  const file = target.closest<HTMLElement>('[data-file]')?.dataset.file;
  if (file) {
    const [path = '', line] = file.split(':');
    post({ type: 'openFile', path, ...(line ? { line: Number(line) } : {}) });
  }
}

export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="markdown" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
