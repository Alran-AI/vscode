import { describeTool } from './model';
import type { SessionSnapshot, TranscriptItem, UserContent } from './types';

function userText(content: readonly UserContent[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return '*[image]*';
      return `*[${part.name}]*`;
    })
    .join('\n\n');
}

function itemToMarkdown(item: TranscriptItem): string | undefined {
  switch (item.kind) {
    case 'user':
      return `## You\n\n${userText(item.content)}`;
    case 'assistant':
      return `## Alran\n\n${item.text}`;
    case 'thought':
      return undefined;
    case 'tool': {
      const heading = `> **${describeTool(item)}** (${item.status})`;
      return item.patch ? `${heading}\n\n\`\`\`diff\n${item.patch.trimEnd()}\n\`\`\`` : heading;
    }
    case 'permission':
      return `> Permission: ${item.title} — ${item.resolution ?? 'pending'}`;
    case 'question':
      return `> Question: ${item.message} — ${item.resolution ?? 'pending'}`;
    case 'plan':
      if (item.markdown) return `## Plan\n\n${item.markdown}`;
      return `## Plan\n\n${(item.entries ?? []).map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`).join('\n')}`;
    case 'notice':
      return `> ${item.text}`;
  }
}

/** The conversation as a Markdown document, for `/export` and `/transcript`. */
export function transcriptToMarkdown(snapshot: SessionSnapshot): string {
  const title = snapshot.meta.title?.trim() || 'Alran Code session';
  const body = snapshot.items.flatMap((item) => itemToMarkdown(item) ?? []);
  return [`# ${title}`, `Session \`${snapshot.meta.id}\` in \`${snapshot.meta.cwd}\``, ...body].join('\n\n') + '\n';
}
