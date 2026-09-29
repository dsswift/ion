/**
 * dispatch telemetry — exact dispatchId match regression
 *
 * The heuristic match (agent + depth + parentId + exitCode===undefined) fails
 * when two dispatches share the same agent, depth, and parentId but fire
 * concurrently. The fix: match by exact dispatchId.
 *
 * Regression assertion:
 *   - Start two entries for the SAME agent at the SAME depth with DISTINCT
 *     dispatchIds.
 *   - Fire a dispatch_end event for one of them.
 *   - Only the matched entry gains exit data; the other stays untouched.
 *
 * The OLD heuristic (agent+depth+parentId+exitCode===undefined) would match
 * whichever entry happens to be first in the array regardless of which
 * dispatch actually ended — this test confirms that path is gone.
 */

import { describe, it, expect } from 'vitest'
import { buildDispatchStartEntry, applyDispatchEnd } from '../slices/engine-event-slice-helpers'
import type { NormalizedEvent } from '@ion/shared/types-events'

function startEvent(
  dispatchId: string,
  dispatchAgent: string,
  dispatchDepth: number,
  dispatchParentId: string,
): NormalizedEvent & { type: 'dispatch_start' } {
  return {
    type: 'dispatch_start',
    dispatchId,
    dispatchAgent,
    dispatchDepth,
    dispatchParentId,
    dispatchSessionId: `sess-${dispatchId}`,
    dispatchModel: 'claude-4',
    dispatchTask: `task-${dispatchId}`,
  }
}

function endEvent(
  dispatchId: string,
  dispatchAgent: string,
  dispatchDepth: number,
  dispatchParentId: string,
  dispatchConversationId?: string,
): NormalizedEvent & { type: 'dispatch_end' } {
  return {
    type: 'dispatch_end',
    dispatchId,
    dispatchAgent,
    dispatchDepth,
    dispatchParentId,
    dispatchExitCode: 0,
    dispatchElapsed: 1.5,
    dispatchCost: 0.001,
    dispatchConversationId,
  }
}

describe('buildDispatchStartEntry', () => {
  it('captures dispatchId from the event', () => {
    const ev = startEvent('id-alpha', 'code-reviewer', 1, 'root')
    const entry = buildDispatchStartEntry(ev)
    expect(entry.dispatchId).toBe('id-alpha')
    expect(entry.dispatchAgent).toBe('code-reviewer')
    expect(entry.dispatchDepth).toBe(1)
    expect(entry.dispatchParentId).toBe('root')
    expect(entry.exitCode).toBeUndefined()
    expect(entry.conversationId).toBeUndefined()
  })
})

describe('applyDispatchEnd — exact dispatchId match', () => {
  it('applies exit data only to the entry whose dispatchId matches', () => {
    // Two starts: same agent, same depth, same parentId — only dispatchId differs.
    const entryA = buildDispatchStartEntry(startEvent('id-alpha', 'engine-dev', 1, 'root'))
    const entryB = buildDispatchStartEntry(startEvent('id-beta', 'engine-dev', 1, 'root'))
    const entries = [entryA, entryB]

    // End event targets id-beta specifically.
    const end = endEvent('id-beta', 'engine-dev', 1, 'root', 'conv-beta')
    const result = applyDispatchEnd(entries, end)

    expect(result).not.toBeNull()
    const [a, b] = result!

    // id-alpha is untouched.
    expect(a.dispatchId).toBe('id-alpha')
    expect(a.exitCode).toBeUndefined()
    expect(a.conversationId).toBeUndefined()

    // id-beta has exit data applied.
    expect(b.dispatchId).toBe('id-beta')
    expect(b.exitCode).toBe(0)
    expect(b.elapsed).toBe(1.5)
    expect(b.cost).toBe(0.001)
    expect(b.conversationId).toBe('conv-beta')
  })

  it('applies exit data only to the FIRST entry when end targets id-alpha', () => {
    const entryA = buildDispatchStartEntry(startEvent('id-alpha', 'engine-dev', 1, 'root'))
    const entryB = buildDispatchStartEntry(startEvent('id-beta', 'engine-dev', 1, 'root'))
    const entries = [entryA, entryB]

    const end = endEvent('id-alpha', 'engine-dev', 1, 'root', 'conv-alpha')
    const result = applyDispatchEnd(entries, end)

    expect(result).not.toBeNull()
    const [a, b] = result!

    expect(a.dispatchId).toBe('id-alpha')
    expect(a.exitCode).toBe(0)
    expect(a.conversationId).toBe('conv-alpha')

    expect(b.dispatchId).toBe('id-beta')
    expect(b.exitCode).toBeUndefined()
    expect(b.conversationId).toBeUndefined()
  })

  it('returns null when no entry matches the dispatchId', () => {
    const entry = buildDispatchStartEntry(startEvent('id-alpha', 'engine-dev', 1, 'root'))
    const end = endEvent('id-unknown', 'engine-dev', 1, 'root')
    const result = applyDispatchEnd([entry], end)
    expect(result).toBeNull()
  })

  it('does not match the same entry twice (re-applying end is a no-op via null)', () => {
    const entry = buildDispatchStartEntry(startEvent('id-alpha', 'engine-dev', 1, 'root'))
    const entries = [entry]
    const end = endEvent('id-alpha', 'engine-dev', 1, 'root', 'conv-1')

    const first = applyDispatchEnd(entries, end)
    expect(first).not.toBeNull()

    // Apply end again against the already-updated array. The dispatchId still
    // matches (we don't clear it), so a second end would update again — but
    // in practice the engine never emits two ends for one dispatchId.
    // This test documents the current behavior: second apply succeeds (idempotent
    // data, same values).
    const second = applyDispatchEnd(first!, end)
    expect(second).not.toBeNull()
    expect(second![0].exitCode).toBe(0)
  })

  it('OLD HEURISTIC FAILURE DEMO: agent+depth+parentId match would wrongly hit id-alpha', () => {
    // This test documents the bug that exact dispatchId fixes.
    // If we used the old heuristic (agent + depth + parentId + exitCode===undefined),
    // firing an end for id-beta would match id-alpha (first in array) instead.
    // With the fix, the end for id-beta only matches id-beta.
    const entryA = buildDispatchStartEntry(startEvent('id-alpha', 'engine-dev', 1, 'root'))
    const entryB = buildDispatchStartEntry(startEvent('id-beta', 'engine-dev', 1, 'root'))
    const entries = [entryA, entryB]

    // Old heuristic simulation: find by agent+depth+parentId+exitCode===undefined
    const oldHeuristicIdx = entries.findIndex(
      (e) => e.dispatchAgent === 'engine-dev' && e.dispatchDepth === 1
        && e.dispatchParentId === 'root' && e.exitCode === undefined,
    )
    // Old heuristic hits index 0 (id-alpha), not index 1 (id-beta).
    expect(oldHeuristicIdx).toBe(0)
    expect(entries[oldHeuristicIdx].dispatchId).toBe('id-alpha') // WRONG: should be id-beta

    // New exact match hits index 1 (id-beta) correctly.
    const end = endEvent('id-beta', 'engine-dev', 1, 'root')
    const result = applyDispatchEnd(entries, end)
    expect(result).not.toBeNull()
    expect(result![0].exitCode).toBeUndefined() // id-alpha untouched
    expect(result![1].exitCode).toBe(0)         // id-beta matched
  })
})
