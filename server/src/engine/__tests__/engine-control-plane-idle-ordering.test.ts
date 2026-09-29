/**
 * Idle-ordering guard — regression coverage for the false-completion defect.
 *
 * THE BUG
 *
 * Sending a prompt marked the conversation Done within milliseconds, complete
 * with the completion sound, seconds before the run actually started. The
 * sequence, observed live on conversation 1783703005832-8f9ea7705fa6:
 *
 *   11:50:50.970  status idle -> connecting     (prompt submitted)
 *   11:50:50.971  start_session -> reconcile_state requested
 *   11:50:50.971  status connecting -> running  (ensureSession succeeded)
 *   11:50:50.976  task_complete SYNTHESIZED     <-- false, 6 ms after the prompt
 *   11:50:57.924  status idle -> running        (the real run, 7 s later)
 *   11:51:30.250  task_complete SYNTHESIZED     <-- the real one
 *
 * The reconcile handshake asked the engine to re-emit its state. SendPrompt had
 * not run yet, so the engine honestly answered `idle` — and the status handler
 * read that pre-dispatch snapshot as the completion of the prompt just sent.
 *
 * The pre-existing 'connecting' skip does not catch it: ensureSession moves the
 * tab to 'running' before the reconcile answer arrives.
 *
 * WHAT THESE TESTS PIN
 *
 * The decision must refuse a snapshot built before the dispatch, and must NOT
 * refuse the run-ending idle — refusing that one would trade a false Done for a
 * conversation stuck in Working forever, which is a worse bug.
 */

import { describe, it, expect } from 'vitest'
import { idleOrdering, type IdleOrderingTab } from '../engine-control-plane-idle-ordering'

function tab(overrides: Partial<IdleOrderingTab> = {}): IdleOrderingTab {
  return {
    activeRequestId: null,
    dispatchRunEpoch: null,
    dispatchAcknowledged: false,
    ...overrides,
  }
}

describe('idleOrdering — engine supplies runEpoch (exact path)', () => {
  it('refuses the reconcile idle that arrives after dispatch but before the run', () => {
    // The live defect: the tab dispatched when the engine's counter read 7, and
    // the reconcile answer was built before SendPrompt advanced it.
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchRunEpoch: 7 }),
      7,
    )
    expect(verdict.stale).toBe(true)
    expect(verdict.reason).toBe('epoch_not_advanced')
  })

  it('accepts the idle that ends the dispatched run', () => {
    // SendPrompt advanced the counter to 8; this idle is that run's exit.
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchRunEpoch: 7 }),
      8,
    )
    expect(verdict.stale).toBe(false)
    expect(verdict.reason).toBe('epoch_advanced')
  })

  it('refuses a snapshot built before the recorded baseline', () => {
    // An older in-flight emission overtaken by the dispatch. Lower than the
    // baseline but not a session restart (see the rebase test below), which the
    // caller distinguishes by reason, not by the boolean.
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchRunEpoch: 7 }),
      3,
    )
    expect(verdict.reason).toBe('session_rebased')
  })

  it('accepts a decreased epoch as a new session rather than a stale snapshot', () => {
    // A session recreated by StartSession begins its counter again at zero.
    // Treating that as "stale" would discard every status the new session
    // emits and strand the conversation.
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchRunEpoch: 12 }),
      0,
    )
    expect(verdict.stale).toBe(false)
    expect(verdict.reason).toBe('session_rebased')
  })

  it('accepts any idle when no prompt is in flight', () => {
    // Heartbeats and genuine run exits on an idle tab are unaffected: with no
    // dispatch outstanding there is no ordering question to answer.
    const verdict = idleOrdering(tab({ dispatchRunEpoch: 7 }), 7)
    expect(verdict.stale).toBe(false)
    expect(verdict.reason).toBe('no_prompt_in_flight')
  })

  it('refuses on the first dispatch of a session, where the baseline is zero', () => {
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchRunEpoch: 0 }),
      0,
    )
    expect(verdict.stale).toBe(true)
    expect(verdict.reason).toBe('epoch_not_advanced')
  })
})

describe('idleOrdering — engine predates runEpoch (fallback path)', () => {
  it('refuses a pre-dispatch idle when the run is not yet confirmed', () => {
    // This is the currently-installed binary: no epoch on the wire, prompt
    // dispatched, engine has not reported state=running for it.
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchAcknowledged: false }),
      undefined,
    )
    expect(verdict.stale).toBe(true)
    expect(verdict.reason).toBe('dispatch_unacknowledged')
  })

  it('accepts the run-ending idle once the engine has confirmed the run', () => {
    // The guard that matters most: activeRequestId stays set for the WHOLE run,
    // so without the confirmation flag this arm would refuse every genuine
    // completion and the conversation would never leave Working.
    const verdict = idleOrdering(
      tab({ activeRequestId: 'req-1', dispatchAcknowledged: true }),
      undefined,
    )
    expect(verdict.stale).toBe(false)
    expect(verdict.reason).toBe('dispatch_acknowledged')
  })

  it('accepts any idle when no prompt is in flight', () => {
    const verdict = idleOrdering(tab(), undefined)
    expect(verdict.stale).toBe(false)
    expect(verdict.reason).toBe('no_prompt_in_flight')
  })

  it('falls back when the engine sends an epoch but the tab has no baseline', () => {
    // A tab that dispatched before any epoch-bearing status arrived. The exact
    // comparison is unavailable, so the confirmation flag decides.
    expect(
      idleOrdering(tab({ activeRequestId: 'req-1', dispatchRunEpoch: null }), 4).reason,
    ).toBe('dispatch_unacknowledged')
    expect(
      idleOrdering(
        tab({ activeRequestId: 'req-1', dispatchRunEpoch: null, dispatchAcknowledged: true }),
        4,
      ).stale,
    ).toBe(false)
  })
})
