/**
 * `terminal.echo`: a keystroke sent to a terminal → the next output for that
 * terminal rendered. Sampled, not every key: one keystroke in
 * `ECHO_SAMPLE_EVERY` opens a span, and at most one span is open per
 * terminal, so a fast typist is a distribution and not a log flood. Output
 * that arrives with no span open (a program printing on its own) is not an
 * echo and is ignored. See docs/observability/log-schema.md § Spans.
 */
import { startSpan, type Span } from '@ion/shared/trace-context'
import { writeRendererSpan } from './span-writer'

/** One keystroke in this many opens a span. */
export const ECHO_SAMPLE_EVERY = 16
/** An echo this late is a program's own output, not the key's; the span is dropped, not recorded. */
export const ECHO_STALE_MS = 5_000

interface OpenEcho {
  span: Span
  openedMs: number
}

const open = new Map<string, OpenEcho>()
const keystrokes = new Map<string, number>()

/** A keystroke left for terminal `key`. Returns whether it was sampled. */
export function noteTerminalKeystroke(key: string, now: () => number = Date.now): boolean {
  const n = (keystrokes.get(key) ?? 0) + 1
  keystrokes.set(key, n)
  if (n % ECHO_SAMPLE_EVERY !== 1 || open.has(key)) return false
  const span = startSpan('terminal.echo', { writer: writeRendererSpan, kind: 'internal', attributes: { terminal_key: key }, now })
  open.set(key, { span, openedMs: now() })
  return true
}

/** Output for terminal `key` was written to its viewer. Ends the open echo span, if one is waiting. */
export function noteTerminalOutput(key: string, bytes: number, now: () => number = Date.now): boolean {
  const waiting = open.get(key)
  if (!waiting) return false
  open.delete(key)
  if (now() - waiting.openedMs > ECHO_STALE_MS) return false
  waiting.span.end({ bytes })
  return true
}

/** A terminal went away; nothing it echoes is a keystroke's. */
export function forgetTerminalEcho(key: string): void {
  open.delete(key)
  keystrokes.delete(key)
}

/** TEST ONLY. */
export function _resetTerminalEchoForTest(): void {
  open.clear()
  keystrokes.clear()
}
