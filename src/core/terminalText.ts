/**
 * What may be typed into a terminal without being run.
 *
 * `Terminal.sendText(text, false)` only withholds the final newline: every line break inside the
 * text ends a line, and the shell runs it. A command is therefore typed out only when it is a single
 * line without a control character (Enter, Tab, Escape, ^C and so on). Anything else is handed to
 * the user to paste, so nothing runs until they have read it and pressed Enter themselves.
 */
export type TerminalPlan =
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'paste'; readonly text: string };

const CONTROL_CHARACTER = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'u');

export function planTerminalText(text: string): TerminalPlan {
  const trimmed = text.replace(/\s+$/u, '');
  if (trimmed.length > 0 && !CONTROL_CHARACTER.test(trimmed)) return { kind: 'type', text: trimmed };
  return { kind: 'paste', text: trimmed };
}
