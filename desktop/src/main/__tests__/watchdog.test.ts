import { describe, it, expect } from 'vitest'
import { evaluateStall, mark, Activity, ACTIVITY_NAMES } from '../watchdog'

// The watchdog's detection brain is evaluateStall. It is the exact function the
// worker runs (embedded via toString), so pinning it here pins the behavior that
// decides whether the next machine-freezing wedge is reported. The worker loop
// itself is thin plumbing around this function.
describe('evaluateStall', () => {
  const staleMs = 5000

  it('reports no transition while the heartbeat is fresh', () => {
    const r = evaluateStall({ nowMs: 10_000, beatMs: 9_500, staleMs, counter: 5, prevCounter: 5, wasStalled: false })
    expect(r.isStalled).toBe(false)
    expect(r.transition).toBe('none')
  })

  it('fires onset the first poll the heartbeat crosses the stale threshold', () => {
    // 6s since the last heartbeat, threshold 5s → stalled, and not previously stalled.
    const r = evaluateStall({ nowMs: 16_000, beatMs: 10_000, staleMs, counter: 5, prevCounter: 5, wasStalled: false })
    expect(r.isStalled).toBe(true)
    expect(r.transition).toBe('onset')
    expect(r.stallMs).toBe(6000)
  })

  it('treats exactly the threshold as stalled (>= boundary)', () => {
    const r = evaluateStall({ nowMs: 15_000, beatMs: 10_000, staleMs, counter: 0, prevCounter: 0, wasStalled: false })
    expect(r.isStalled).toBe(true)
    expect(r.transition).toBe('onset')
  })

  it('reports ongoing on subsequent polls while still stalled', () => {
    const r = evaluateStall({ nowMs: 20_000, beatMs: 10_000, staleMs, counter: 9, prevCounter: 5, wasStalled: true })
    expect(r.transition).toBe('ongoing')
  })

  it('reports recovery once the heartbeat resumes after a stall', () => {
    const r = evaluateStall({ nowMs: 21_000, beatMs: 20_800, staleMs, counter: 9, prevCounter: 9, wasStalled: true })
    expect(r.isStalled).toBe(false)
    expect(r.transition).toBe('recovery')
  })

  it('flags spinning when the activity counter climbs during a stall (active hot loop)', () => {
    // Counter advanced 4000 since the last poll while the heartbeat was stale:
    // the main thread is spinning through an instrumented breadcrumb.
    const r = evaluateStall({ nowMs: 20_000, beatMs: 10_000, staleMs, counter: 8000, prevCounter: 4000, wasStalled: true })
    expect(r.counterDelta).toBe(4000)
    expect(r.counterDelta > 0).toBe(true)
  })

  it('reports a flat counter during a stall (stuck in un-instrumented synchronous code)', () => {
    const r = evaluateStall({ nowMs: 20_000, beatMs: 10_000, staleMs, counter: 4000, prevCounter: 4000, wasStalled: true })
    expect(r.counterDelta).toBe(0)
    expect(r.counterDelta > 0).toBe(false)
  })
})

describe('mark', () => {
  it('is a safe no-op when the watchdog has not been started', () => {
    // Call sites in hot paths (engine-event dispatch, relay send) invoke mark()
    // unconditionally. Before startWatchdog() runs — and in tests — the shared
    // buffer is absent, so mark must never throw.
    expect(() => mark(Activity.EngineEvent)).not.toThrow()
    expect(() => mark(Activity.RelaySend)).not.toThrow()
    expect(() => mark(Activity.RelayCompress)).not.toThrow()
  })
})

describe('Activity ↔ ACTIVITY_NAMES sync', () => {
  // The worker labels every stall record by indexing ACTIVITY_NAMES with the
  // activity code. If the enum and the names table drift, a wedge is reported
  // under the wrong label and the diagnosis is misdirected. This invariant is
  // the whole reason the fine-grained relay sub-stage breadcrumbs are useful.
  it('has exactly one name per activity code, indexed by the code value', () => {
    const codes = Object.values(Activity)
    expect(ACTIVITY_NAMES).toHaveLength(codes.length)
    for (const code of codes) {
      expect(typeof ACTIVITY_NAMES[code]).toBe('string')
      expect(ACTIVITY_NAMES[code].length).toBeGreaterThan(0)
    }
    // Names are distinct so a stall label is unambiguous.
    expect(new Set(ACTIVITY_NAMES).size).toBe(ACTIVITY_NAMES.length)
  })

  it('maps the relay send sub-stages to their exact labels', () => {
    // These are the breadcrumbs a future relay-send wedge will surface. Pin the
    // exact strings so the label the operator greps for cannot silently change.
    expect(ACTIVITY_NAMES[Activity.RelayStringify]).toBe('relay_stringify')
    expect(ACTIVITY_NAMES[Activity.RelayCompress]).toBe('relay_compress')
    expect(ACTIVITY_NAMES[Activity.RelayEncrypt]).toBe('relay_encrypt')
    expect(ACTIVITY_NAMES[Activity.RelayRecord]).toBe('relay_record')
    expect(ACTIVITY_NAMES[Activity.RelayDeliver]).toBe('relay_deliver')
  })
})
