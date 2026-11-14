import { memo } from 'preact/compat';
import { useMemo } from 'preact/hooks';

import { FILE_REFERENCE, renderMarkdown } from '../markdown';
import { post } from '../store';

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
  if (file && FILE_REFERENCE.test(file)) {
    const [path = '', line] = file.split(':');
    post({ type: 'openFile', path, ...(line ? { line: Number(line) } : {}) });
  }
}

export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class="markdown" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
