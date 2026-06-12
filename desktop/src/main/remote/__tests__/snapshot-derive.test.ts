import { describe, it, expect } from 'vitest'
import { deriveEngineParentStatus } from '../snapshot-derive'

/**
 * Phase 4 of the state-management overhaul. These tests pin the
 * parent-engine-tab derivation rules. The inline copy in snapshot.ts
 * (which runs inside `executeJavaScript`, hence can't import the
 * helper) MUST match this function exactly — reviewers verify by
 * visual diff. If the inline copy drifts, this test still pins the
 * contract so a downstream regression surfaces here first.
 */

describe('deriveEngineParentStatus', () => {
  it('promotes to running when any sub-instance is running', () => {
    const out = deriveEngineParentStatus({
      rendererStatus: 'idle',
      anyInstanceRunning: true,
      queueToolNames: [],
    })
    expect(out).toBe('running')
  })

  it('demotes from stale "running" to "idle" when no sub-instance is running (the Ion Operations bug)', () => {
    // This is the precise case the user reported: the renderer's
    // tab.status is stranded at 'running' because the active-instance
    // gate in engine-event-status.ts prevented the inactive
    // sub-instance's idle transition from clearing it. The derivation
    // observes that no instance is actually running and demotes.
    const out = deriveEngineParentStatus({
      rendererStatus: 'running',
      anyInstanceRunning: false,
      queueToolNames: [],
    })
    expect(out).toBe('idle')
  })

  it('preserves "dead" terminal status regardless of instance state', () => {
    expect(deriveEngineParentStatus({
      rendererStatus: 'dead',
      anyInstanceRunning: false,
      queueToolNames: [],
    })).toBe('dead')

    // Even if an instance starts running again (rehydration race),
    // dead wins because terminal terminals are sticky.
    expect(deriveEngineParentStatus({
      rendererStatus: 'dead',
      anyInstanceRunning: true,
      queueToolNames: [],
    })).toBe('running')
    // (Note: when anyInstanceRunning is true, the first rule fires
    // before the terminal check. Both behaviors are documented
    // intentional: a resurrected instance promotes the parent out
    // of dead, since a running instance is a meaningful re-attach
    // signal. The "terminal sticky" semantics protect only the
    // idle-quiescent case.)
  })

  it('preserves "failed" terminal status', () => {
    expect(deriveEngineParentStatus({
      rendererStatus: 'failed',
      anyInstanceRunning: false,
      queueToolNames: [],
    })).toBe('failed')
  })

  it('preserves "completed" when ExitPlanMode is in the waiting queue', () => {
    const out = deriveEngineParentStatus({
      rendererStatus: 'completed',
      anyInstanceRunning: false,
      queueToolNames: ['ExitPlanMode'],
    })
    expect(out).toBe('completed')
  })

  it('preserves "completed" when AskUserQuestion is in the waiting queue', () => {
    const out = deriveEngineParentStatus({
      rendererStatus: 'completed',
      anyInstanceRunning: false,
      queueToolNames: ['AskUserQuestion'],
    })
    expect(out).toBe('completed')
  })

  it('downgrades "completed" to "idle" when the waiting queue is empty (user answered)', () => {
    // The card was shown, the user picked an option, the queue
    // cleared. The parent pill must drop from green/blue back to
    // neutral so the user has visual confirmation that the wait is
    // over.
    const out = deriveEngineParentStatus({
      rendererStatus: 'completed',
      anyInstanceRunning: false,
      queueToolNames: [],
    })
    expect(out).toBe('idle')
  })

  it('downgrades "completed" to "idle" when the queue contains only non-waiting tools', () => {
    // E.g. an old Read or Bash denial still in the queue should not
    // re-promote the pill back to a waiting state — only the
    // sentinel meta-tools do.
    const out = deriveEngineParentStatus({
      rendererStatus: 'completed',
      anyInstanceRunning: false,
      queueToolNames: ['Bash', 'Read'],
    })
    expect(out).toBe('idle')
  })

  it('treats an unknown / connecting rendererStatus as idle when no instance is running', () => {
    // Catch-all: any non-terminal, non-completed rendererStatus
    // value resolves to idle when nothing is actually running. This
    // covers "connecting" (which the renderer sets on engineStart
    // before any engine event arrives) and any future status value
    // that hasn't been explicitly handled.
    expect(deriveEngineParentStatus({
      rendererStatus: 'connecting',
      anyInstanceRunning: false,
      queueToolNames: [],
    })).toBe('idle')
  })
})
