import markSource from '../../../media/activitybar.svg';

const MARK_URL = `url("data:image/svg+xml,${encodeURIComponent(markSource)}")`;

/**
 * Alran's mark: two ribbons of brushed steel. It is drawn as a mask over a metal gradient, so it takes
 * the theme's colours (silver on dark, graphite on light) and can catch the light while Alran works.
 */
export function AlranMark({ size = 48, live = false }: { readonly size?: number; readonly live?: boolean }) {
  return (
    <span
      class={`alran-mark${live ? ' live' : ''}`}
      style={{ '--mark': MARK_URL, width: `${String(size)}px` }}
      aria-hidden="true"
    />
  );
}
