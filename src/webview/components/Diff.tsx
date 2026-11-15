import { collapseContext, diffText, patchToDiffLines, type DiffLine } from '../../shared/patch';
import type { DiffStat } from '../../shared/ui';

const PREFIX: Record<DiffLine['type'], string> = { add: '+', remove: '-', context: ' ', hunk: '' };

export function DiffLines({ lines }: { readonly lines: readonly DiffLine[] }) {
  return (
    <pre class="diff">
      {lines.map((line, index) => (
        <div key={index} class={`diff-line diff-${line.type}`}>
          <span class="diff-prefix">{PREFIX[line.type]}</span>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

export function PatchView({ patch }: { readonly patch: string }) {
  return <DiffLines lines={patchToDiffLines(patch)} />;
}

export function TextDiffView({ before, after }: { readonly before: string; readonly after: string }) {
  return <DiffLines lines={collapseContext(diffText(before, after))} />;
}

/** `+14 −3`: the lines a change added and removed; a side that is zero is left out. */
export function DiffStatBadge({ stat, className = '' }: { readonly stat: DiffStat; readonly className?: string }) {
  return (
    <span
      class={`tool-stat${className ? ` ${className}` : ''}`}
      title={`${String(stat.added)} line${stat.added === 1 ? '' : 's'} added, ${String(stat.removed)} removed`}
    >
      {stat.added > 0 ? <span class="stat-add">+{stat.added}</span> : null}
      {stat.added > 0 && stat.removed > 0 ? ' ' : null}
      {stat.removed > 0 ? <span class="stat-remove">−{stat.removed}</span> : null}
    </span>
  );
}
