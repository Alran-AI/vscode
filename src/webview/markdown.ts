import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';

/** A file the transcript offers to open: a relative path with an optional `:line`. */
export const FILE_REFERENCE = /^(?:[\w@.-]+\/)*[\w@.-]+\.[a-zA-Z0-9]{1,8}(?::\d+)?$/u;

/** The attributes the click handler acts on. Only this renderer may set them. */
const ACTION_ATTRIBUTES = ['data-code-action', 'data-language', 'data-file'] as const;
const TRUST_ATTRIBUTE = 'data-trust';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${String(char.charCodeAt(0))};`);
}

/**
 * Marks the elements this renderer emitted. Model output goes through `marked`, which passes raw
 * HTML on unchanged, and DOMPurify lets `data-*` attributes through, so a reply containing
 * `<code data-file="/home/me/.ssh/id_rsa">` would otherwise look exactly like a file link the
 * renderer made. The marker is fresh for every render, so text the model wrote cannot repeat it.
 */
let renderTrust = '';

const marked = new Marked({
  gfm: true,
  renderer: {
    // Raw HTML in a reply is shown as text. The markup this renderer builds is the only markup the
    // transcript has, so no reply can forge a file link or a code-block button.
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').split(/\s+/u)[0] ?? '';
      const known = language && hljs.getLanguage(language);
      const highlighted = known
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text);
      const canRun = /^(bash|sh|shell|zsh|console)$/u.test(language);
      const trust = `${TRUST_ATTRIBUTE}="${renderTrust}"`;
      const action = (name: string, title: string, icon: string): string =>
        `<button ${trust} data-code-action="${name}" title="${title}"><i class="codicon codicon-${icon}"></i></button>`;
      return `<div ${trust} class="code-block" data-language="${escapeHtml(language)}"><div class="code-toolbar"><span class="code-language">${escapeHtml(language)}</span>${action('copy', 'Copy', 'copy')}${action('insert', 'Insert at cursor', 'insert')}${action('new-file', 'Open in new file', 'new-file')}${canRun ? action('run', 'Paste into terminal', 'terminal') : ''}</div><pre><code class="hljs">${highlighted}</code></pre></div>`;
    },
    codespan({ text }: Tokens.Codespan): string {
      const decoded = text.replace(/&amp;/gu, '&');
      return FILE_REFERENCE.test(decoded)
        ? `<code ${TRUST_ATTRIBUTE}="${renderTrust}" class="file-link" data-file="${escapeHtml(decoded)}">${escapeHtml(decoded)}</code>`
        : `<code>${escapeHtml(decoded)}</code>`;
    },
  },
});

// Without a DOM (the unit tests) DOMPurify is only a factory and has no hooks.
if (typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!renderTrust || !node.hasAttribute) return;
    const trusted = node.getAttribute(TRUST_ATTRIBUTE) === renderTrust;
    if (!trusted) for (const name of ACTION_ATTRIBUTES) node.removeAttribute(name);
    node.removeAttribute(TRUST_ATTRIBUTE);
  });
}

function freshTrust(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Markdown to HTML, before sanitizing. Separate so it can be checked without a DOM. */
export function parseMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}

export function renderMarkdown(text: string): string {
  renderTrust = freshTrust();
  try {
    const html = parseMarkdown(text);
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_ATTR: ['style'],
      FORBID_TAGS: ['style', 'form', 'input', 'img'],
      ADD_ATTR: [...ACTION_ATTRIBUTES, TRUST_ATTRIBUTE],
    });
  } finally {
    renderTrust = '';
  }
}
