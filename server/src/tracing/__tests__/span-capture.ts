/**
 * Reads span records back out of a mocked server logger. A span is the
 * `tag=span` line `writeServerSpan` writes (INFO, or WARN when failed), so a
 * test that mocked `../../logger` with `vi.fn()`s can list every span an
 * operation wrote, by name, with its attributes. Not a test file itself.
 */
import type { Mock } from 'vitest'

export interface CapturedSpan {
  name: string
  level: 'INFO' | 'WARN'
  fields: Record<string, unknown>
}

export interface SpanLogger {
  log: Mock
  warn: Mock
}

/** Every span the logger saw, in the order written. */
export function capturedSpans(logger: SpanLogger): CapturedSpan[] {
  const out: Array<CapturedSpan & { order: number }> = []
  const collect = (mock: Mock, level: 'INFO' | 'WARN'): void => {
    mock.mock.calls.forEach((call, i) => {
      if (call[0] !== 'span') return
      out.push({ name: call[1] as string, level, fields: (call[2] ?? {}) as Record<string, unknown>, order: mock.mock.invocationCallOrder[i] })
    })
  }
  collect(logger.log, 'INFO')
  collect(logger.warn, 'WARN')
  return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...span }) => span)
}

/** The spans named `name`. */
export function spansNamed(logger: SpanLogger, name: string): CapturedSpan[] {
  return capturedSpans(logger).filter((s) => s.name === name)
}

/** The one span named `name`; fails when there is not exactly one. */
export function theSpan(logger: SpanLogger, name: string): CapturedSpan {
  const found = spansNamed(logger, name)
  if (found.length !== 1) throw new Error(`expected one ${name} span, found ${found.length}: ${JSON.stringify(capturedSpans(logger).map((s) => s.name))}`)
  return found[0]
}
