/**
 * Pins the observability contract of the tab-status seam.
 *
 * Background: three conversations finished their work and went to a done state,
 * but the UI kept showing every running affordance and refused input in the
 * composer. Diagnosis stalled because `setTabStatus` — the single canonical
 * write path for tab status, with call sites across the renderer — logged
 * nothing at all. There was no record of which site wrote the stuck status, in
 * which window, or which attempted writes were refused, so the cause could not
 * be attributed from `~/.ion/desktop.jsonl` and had to be guessed at from
 * source. That is the failure the logging policy exists to prevent ("every code
 * path must be observable through logs alone").
 *
 * These tests assert the seam reports EVERY outcome, not just the mutating one.
 * A no-op is the interesting case in a stuck-status investigation: "the tab was
 * already at the target" and "a guard refused the transition" are the two ways
 * a status silently fails to move, and both were previously invisible.
 *
 * Reverting the log calls in tab-status-transition.ts turns every case here red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabState } from '@ion/shared/types'

// rendererLogger (../rendererLogger) used to route every call through the
// preload contextBridge's window.ion.logWrite(level, tag, msg, fields) to the
// main process. The moved store now runs in-process and rendererLogger calls
// the server's own per-level logger (../../../logger: trace/debug/info/warn/
// error) directly — same tag/msg/fields shape, but the level is now which
// function was called rather than a positional string argument.
const infoLog = vi.fn()
const debugLog = vi.fn()
const warnLog = vi.fn()
vi.mock('../../../logger', () => ({
  trace: vi.fn(),
  debug: (...args: any[]) => debugLog(...args),
  info: (...args: any[]) => infoLog(...args),
  warn: (...args: any[]) => warnLog(...args),
  error: vi.fn(),
}))

import { setTabStatus, logTabStatusPatch } from '../tab-status-transition'

function makeTab(id: string, status: TabState['status'] = 'idle'): TabState {
  return { id, status } as unknown as TabState
}

/**
 * The single status line emitted for one call, parsed from the logger stub.
 * A write that moved the status is INFO; an `already-at-target` one is DEBUG.
 */
function statusLine(): { msg: string; fields: Record<string, unknown> } {
  const info = infoLog.mock.calls.filter((c) => c[0] === 'tab.status')
  const debug = debugLog.mock.calls.filter((c) => c[0] === 'tab.status')
  expect(info.length + debug.length).toBe(1)
  const [, msg, fields] = (info[0] ?? debug[0]) as [string, string, Record<string, unknown>]
  expect(debug.length === 1).toBe(fields.outcome === 'already-at-target')
  return { msg, fields }
}

describe('setTabStatus observability', () => {
  beforeEach(() => {
    infoLog.mockClear()
    debugLog.mockClear()
    warnLog.mockClear()
  })

  it('logs an applied transition with both statuses and the source', () => {
    setTabStatus([makeTab('tab-1', 'connecting')], 'tab-1', 'running', 'implement.plan')
    const { fields } = statusLine()
    expect(fields).toMatchObject({
      tab_id: 'tab-1',
      from: 'connecting',
      to: 'running',
      source: 'implement.plan',
      outcome: 'applied',
    })
  })

  it('logs a guard rejection — the silent refusal that hides a stuck status', () => {
    // A running tab that a late idle tried to knock back: the write is refused
    // and, before this change, left no trace whatsoever.
    setTabStatus([makeTab('tab-1', 'running')], 'tab-1', 'idle', 'engine.start-online', (t) => t.status === 'connecting')
    const { fields } = statusLine()
    expect(fields).toMatchObject({
      from: 'running',
      to: 'idle',
      source: 'engine.start-online',
      outcome: 'guard-rejected',
    })
  })

  it('logs a no-op when the tab is already at the target status', () => {
    setTabStatus([makeTab('tab-1', 'idle')], 'tab-1', 'idle', 'engine.start-online')
    expect(statusLine().fields).toMatchObject({ outcome: 'already-at-target' })
  })

  it('logs a write aimed at a tab this window does not have', () => {
    // How an owner/mirror divergence first becomes visible: the other window
    // holds the tab and this one does not.
    setTabStatus([makeTab('tab-1')], 'absent-tab', 'running', 'implement.plan')
    expect(statusLine().fields).toMatchObject({ outcome: 'tab-missing', from: 'unknown' })
  })

  it('stamps the window role, so two stores disagreeing is attributable', () => {
    setTabStatus([makeTab('tab-1', 'idle')], 'tab-1', 'running', 'implement.plan')
    expect(statusLine().fields).toMatchObject({ window_role: 'server' })
  })

  it('reports came_to_rest on an active→terminal transition', () => {
    // came_to_rest drives the idleSince stamp; recording it makes an inbox
    // ordering complaint checkable against the status trail.
    setTabStatus([makeTab('tab-1', 'running')], 'tab-1', 'completed', 'event.task-complete')
    expect(statusLine().fields).toMatchObject({ outcome: 'applied', came_to_rest: true })
  })

  it('logs at INFO so the trail survives without a verbosity flag', () => {
    // The level is now which logger function was called, not a positional
    // string argument -- so this asserts the call landed on info(), not
    // warn()/debug()/error(), for the same "always observable" guarantee.
    setTabStatus([makeTab('tab-1', 'idle')], 'tab-1', 'running', 'implement.plan')
    expect(infoLog.mock.calls.some((c) => c[0] === 'tab.status')).toBe(true)
    expect(warnLog).not.toHaveBeenCalled()
  })

  it('emits exactly one line per call', () => {
    setTabStatus([makeTab('tab-1', 'idle')], 'tab-1', 'running', 'implement.plan')
    expect(infoLog.mock.calls.filter((c) => c[0] === 'tab.status')).toHaveLength(1)
  })
})

/**
 * Direct writes — the sites that build their own tab object or mutate a patch
 * instead of calling setTabStatus.
 *
 * These originally passed a literal 'applied', which made the log claim a
 * transition on writes that changed nothing. Observed live after the first
 * build: an engine heartbeat re-asserting a status produced
 *
 *   from=connecting to=connecting source=event.status-transition outcome=applied
 *
 * which reads as a real transition and disagrees with setTabStatus, where the
 * identical pair reports 'already-at-target'. Deriving the outcome is what makes
 * "applied" mean the status actually moved.
 */
describe('logTabStatusPatch derives the outcome', () => {
  beforeEach(() => {
    infoLog.mockClear()
    debugLog.mockClear()
    warnLog.mockClear()
  })

  it('reports applied when the status actually changes', () => {
    logTabStatusPatch('tab-1', 'connecting', 'running', 'event.status-transition')
    expect(statusLine().fields).toMatchObject({ from: 'connecting', to: 'running', outcome: 'applied' })
  })

  it('reports already-at-target for the observed connecting→connecting re-assert', () => {
    logTabStatusPatch('tab-1', 'connecting', 'connecting', 'event.status-transition')
    expect(statusLine().fields).toMatchObject({ outcome: 'already-at-target' })
  })

  it('reports already-at-target for an idle→idle heartbeat tick', () => {
    logTabStatusPatch('tab-1', 'idle', 'idle', 'event.status-transition')
    expect(statusLine().fields).toMatchObject({ outcome: 'already-at-target' })
  })

  it('agrees with setTabStatus on the same from/to pair', () => {
    // The two halves of the status trail must not disagree: one filter reads
    // both, so an identical pair has to produce an identical outcome.
    logTabStatusPatch('tab-1', 'idle', 'idle', 'event.status-transition')
    const patchOutcome = statusLine().fields.outcome
    infoLog.mockClear()
    debugLog.mockClear()
    warnLog.mockClear()
    setTabStatus([makeTab('tab-1', 'idle')], 'tab-1', 'idle', 'engine.start-online')
    expect(statusLine().fields.outcome).toBe(patchOutcome)
  })

  it('keeps side-effect fields on a no-op write', () => {
    // A heartbeat can clear a run-scoped queue while leaving status alone. That
    // work is real and must stay visible; it just is not a status transition.
    logTabStatusPatch('tab-1', 'idle', 'idle', 'event.status-transition', { cleared_queue: true })
    expect(statusLine().fields).toMatchObject({ outcome: 'already-at-target', cleared_queue: true })
  })
})
