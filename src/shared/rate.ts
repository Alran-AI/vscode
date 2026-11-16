/**
 * Output speed of the model, measured from what the agent streams to the chat.
 *
 * The agent protocol carries no token counts for a streamed answer, so the speed is an estimate:
 * about four characters per token, over the time the text was actually flowing. A pause longer than
 * `IDLE_GAP_MS` (a tool running, a permission prompt, the model thinking silently) is not counted,
 * otherwise a long turn would show the speed of its slowest tool, not of the model.
 *
 * The CLI shows the same figure with a `~` when it is an estimate; so does the chat.
 */

const CHARS_PER_TOKEN = 4;
/** A gap between two chunks longer than this is waiting, not streaming. */
const IDLE_GAP_MS = 2_000;
/** Below this the figure jumps around too much to show. */
const MIN_STREAM_MS = 600;
const MIN_TOKENS = 8;

export interface OutputRateView {
  readonly tokensPerSecond: number;
  /** Always true for now: the figure is derived from text length. */
  readonly estimated: boolean;
  /** The turn is still streaming. */
  readonly live: boolean;
}

export class OutputRateTracker {
  private chars = 0;
  private streamMs = 0;
  private lastAt: number | undefined;

  reset(): void {
    this.chars = 0;
    this.streamMs = 0;
    this.lastAt = undefined;
  }

  /** Call for every streamed text chunk (answer or thinking). */
  add(chars: number, now: number): void {
    if (chars <= 0) return;
    if (this.lastAt !== undefined) {
      const gap = now - this.lastAt;
      if (gap > 0 && gap <= IDLE_GAP_MS) this.streamMs += gap;
    }
    this.chars += chars;
    this.lastAt = now;
  }

  /** The speed so far, or undefined while there is too little to say anything honest. */
  view(live: boolean): OutputRateView | undefined {
    const tokens = this.chars / CHARS_PER_TOKEN;
    if (this.streamMs < MIN_STREAM_MS || tokens < MIN_TOKENS) return undefined;
    return { tokensPerSecond: tokens / (this.streamMs / 1000), estimated: true, live };
  }
}

/** Whole tokens from ten up; one decimal below, as the CLI prints it. */
export function formatTokensPerSecond(value: number): string {
  return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
}

export interface RateStatus {
  /** Status bar text with a codicon: `$(zap) ~225 t/s`. */
  readonly text: string;
  readonly tooltip: string;
}

/**
 * What the status bar shows about the speed: only while an answer is streaming.
 *
 * Once the turn is over the figure belongs to the chat ("last answer was written at"), and a status bar
 * that kept it would show a speed for an agent that is no longer writing. The `~` stays: it is an
 * estimate from the text length, here as in the chat and in the CLI.
 */
export function rateStatus(view: OutputRateView | undefined): RateStatus | undefined {
  if (!view?.live) return undefined;
  const figure = formatTokensPerSecond(view.tokensPerSecond);
  return {
    text: `$(zap) ${view.estimated ? '~' : ''}${figure} t/s`,
    tooltip: `Alran is writing at about ${figure} tokens per second${view.estimated ? ' (estimated from the length of the text)' : ''}. Click to open the chat.`,
  };
}
