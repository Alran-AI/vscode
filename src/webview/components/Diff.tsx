import { collapseContext, diffText, patchToDiffLines, type DiffLine } from '../../shared/patch';

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
