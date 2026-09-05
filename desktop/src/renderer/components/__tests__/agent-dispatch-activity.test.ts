// @vitest-environment node
//
// Convergence/dedupe test — the correctness crux of architecture C (push +
// slow full-snapshot reconcile). Pins that push deltas fold by stable key and
// that a reconcile snapshot converges with in-flight push entries to exactly
// one entry per logical item: no duplicate, no dropped in-flight partial.
//
// Reverting the dedupe in foldActivity/reconcileActivity turns this red, which
// is what keeps a future refactor from silently reintroducing double-render.
import { describe, it, expect } from 'vitest'
import {
  emptyActivityState,
  foldActivity,
  activityMessages,
  reconcileActivity,
  type DispatchActivityState,
  type DispatchActivityDelta,
} from '../agent-dispatch-activity'
import type { Message } from '../../../shared/types'

function fold(state: DispatchActivityState, delta: Partial<DispatchActivityDelta> & Pick<DispatchActivityDelta, 'dispatchActivityKind' | 'dispatchSeq'>): DispatchActivityState {
  return foldActivity(state, {
    dispatchConversationId: 'conv-1',
    toolName: delta.toolName,
    toolId: delta.toolId,
    dispatchTextDelta: delta.dispatchTextDelta,
    dispatchToolIsError: delta.dispatchToolIsError,
    dispatchActivityTs: delta.dispatchActivityTs,
    dispatchResetAfterSeq: delta.dispatchResetAfterSeq,
    dispatchActivityKind: delta.dispatchActivityKind,
    dispatchSeq: delta.dispatchSeq,
  }).state
}

describe('foldActivity — push dedupe by toolId and seq', () => {
  it('folds a tool_start + tool_end pair (same toolId) into ONE tool entry, updated in place', () => {
    let s = emptyActivityState()
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 'tool-1', toolName: 'Read' })
    s = fold(s, { dispatchActivityKind: 'tool_end', dispatchSeq: 2, toolId: 'tool-1', dispatchToolIsError: false })

    const msgs = activityMessages(s)
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].toolId).toBe('tool-1')
    expect(toolMsgs[0].toolName).toBe('Read')
    expect(toolMsgs[0].toolStatus).toBe('completed')
  })

  it('marks tool_end with isError as error status', () => {
    let s = emptyActivityState()
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 'tool-x', toolName: 'Bash' })
    s = fold(s, { dispatchActivityKind: 'tool_end', dispatchSeq: 2, toolId: 'tool-x', dispatchToolIsError: true })
    expect(activityMessages(s).filter((m) => m.role === 'tool')[0].toolStatus).toBe('error')
  })

  it('discards uncommitted tool and text rows on stream reset', () => {
    let s = emptyActivityState()
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 'done', toolName: 'Read' })
    s = fold(s, { dispatchActivityKind: 'tool_end', dispatchSeq: 2, toolId: 'done' })
    s = fold(s, { dispatchActivityKind: 'text', dispatchSeq: 3, dispatchTextDelta: 'partial' })
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 4, toolId: 'partial', toolName: 'Write' })

    s = fold(s, { dispatchActivityKind: 'stream_reset', dispatchSeq: 5, dispatchResetAfterSeq: 2 })

    const msgs = activityMessages(s)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].toolId).toBe('done')
    expect(msgs[0].toolStatus).toBe('completed')
  })

  it('folds a coalesced text run sharing a seq slot into ONE ordered text entry', () => {
    let s = emptyActivityState()
    // A coalesced run re-emitting at the same seq updates in place.
    s = fold(s, { dispatchActivityKind: 'text', dispatchSeq: 3, dispatchTextDelta: 'hello' })
    s = fold(s, { dispatchActivityKind: 'text', dispatchSeq: 3, dispatchTextDelta: 'hello world' })

    const textMsgs = activityMessages(s).filter((m) => m.role === 'assistant')
    expect(textMsgs).toHaveLength(1)
    expect(textMsgs[0].content).toBe('hello world')
  })

  // -----------------------------------------------------------------------
  // Ordering: ts primary, seq tiebreaker
  //
  // Each assertion is written so it FAILS if the sort reverts to seq-only:
  //   - "ts primary": seq 3 with ts=100 emitted before seq 1 with ts=200 must
  //     render seq-3 first. Seq-only sort would place seq 1 first → red.
  //   - "tiebreaker": two entries with equal ts must fall back to seq order.
  //     (With seq-only sort the tiebreaker case still passes, but the ts-primary
  //     case above already catches the regression.)
  //   - "ts absent/0 fallback": when ts is absent (0) for all entries, ordering
  //     must degrade to seq order, matching pre-ts behavior.
  // -----------------------------------------------------------------------

  it('orders entries by ts (primary) — seq 3 with lower ts sorts before seq 1 with higher ts', () => {
    let s = emptyActivityState()
    // Emitted out of seq order. The sort key is ts, not seq.
    // seq=3 ts=100 arrives first; seq=1 ts=200 arrives second.
    s = fold(s, { dispatchActivityKind: 'text', dispatchSeq: 3, dispatchActivityTs: 100, dispatchTextDelta: 'early-ts' })
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, dispatchActivityTs: 200, toolId: 't1', toolName: 'Read' })
    const msgs = activityMessages(s)
    // ts=100 (seq 3, assistant) must come before ts=200 (seq 1, tool).
    // A seq-only sort would place seq 1 first → this assert fails on unfixed code.
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[1].role).toBe('tool')
  })

  it('orders entries by seq when ts is equal (tiebreaker)', () => {
    let s = emptyActivityState()
    // Both entries have the same ts. Seq is the tiebreaker.
    s = fold(s, { dispatchActivityKind: 'text', dispatchSeq: 5, dispatchActivityTs: 1000, dispatchTextDelta: 'seq-5' })
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 2, dispatchActivityTs: 1000, toolId: 't2', toolName: 'Bash' })
    const msgs = activityMessages(s)
    // seq 2 (tool) before seq 5 (text) when ts is identical.
    expect(msgs[0].role).toBe('tool')
    expect(msgs[1].role).toBe('assistant')
  })

  it('falls back to seq order when ts is absent (0) for all entries', () => {
    let s = emptyActivityState()
    // No dispatchActivityTs provided — both entries have ts=0.
    s = fold(s, { dispatchActivityKind: 'text', dispatchSeq: 3, dispatchTextDelta: 'second' })
    s = fold(s, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 't', toolName: 'Read' })
    const msgs = activityMessages(s)
    // ts is 0 for both, so seq is the effective sort key: seq 1 (tool) before seq 3 (text).
    expect(msgs[0].role).toBe('tool')
    expect(msgs[1].role).toBe('assistant')
  })
})

describe('reconcileActivity — push + snapshot converge to one entry per item', () => {
  it('drops a push tool entry the snapshot already carries by toolId (no duplicate)', () => {
    let push = emptyActivityState()
    push = fold(push, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 'tool-1', toolName: 'Read' })
    push = fold(push, { dispatchActivityKind: 'tool_end', dispatchSeq: 2, toolId: 'tool-1', dispatchToolIsError: false })

    // Snapshot (from the file) carries the same tool by its persisted id.
    const snapshot: Message[] = [
      { id: 'tool-1', role: 'tool', content: 'file contents', toolId: 'tool-1', toolName: 'Read', toolStatus: 'completed', timestamp: 1 },
    ]

    const merged = reconcileActivity(snapshot, push)
    const toolEntries = merged.filter((m) => m.toolId === 'tool-1')
    expect(toolEntries).toHaveLength(1)
    // The snapshot's version (with content) wins.
    expect(toolEntries[0].content).toBe('file contents')
  })

  it('drops a push text run the snapshot already carries (finalized), keeping the persisted one', () => {
    let push = emptyActivityState()
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 1, dispatchTextDelta: 'analysis done' })

    const snapshot: Message[] = [
      { id: 'm1', role: 'assistant', content: 'analysis done', timestamp: 1 },
    ]

    const merged = reconcileActivity(snapshot, push)
    const textEntries = merged.filter((m) => m.role === 'assistant' && m.content === 'analysis done')
    expect(textEntries).toHaveLength(1)
  })

  it('preserves an in-flight push partial the snapshot does not yet cover', () => {
    let push = emptyActivityState()
    // Tool already persisted in the snapshot.
    push = fold(push, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 'tool-1', toolName: 'Read' })
    push = fold(push, { dispatchActivityKind: 'tool_end', dispatchSeq: 2, toolId: 'tool-1' })
    // Live text not yet persisted (still streaming).
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 3, dispatchTextDelta: 'still thinking...' })

    const snapshot: Message[] = [
      { id: 'tool-1', role: 'tool', content: 'done', toolId: 'tool-1', toolName: 'Read', toolStatus: 'completed', timestamp: 1 },
    ]

    const merged = reconcileActivity(snapshot, push)
    // Tool collapses to one; the in-flight text survives.
    expect(merged.filter((m) => m.toolId === 'tool-1')).toHaveLength(1)
    expect(merged.filter((m) => m.content === 'still thinking...')).toHaveLength(1)
  })

  it('with no snapshot loaded yet, push entries alone drive the transcript', () => {
    let push = emptyActivityState()
    push = fold(push, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, toolId: 'tool-1', toolName: 'Read' })
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 2, dispatchTextDelta: 'hi' })
    const merged = reconcileActivity([], push)
    expect(merged).toHaveLength(2)
  })
})

describe('reconcileActivity — turn-level coverage for incremental text fragments', () => {
  // The engine emits each coalesced text flush at a NEW monotonic seq carrying
  // only the INCREMENTAL text since the previous flush. Those fragments
  // concatenate, in materialized order, to exactly the single finalized
  // assistant message the snapshot persists. The merge must drop ALL fragments
  // when the snapshot covers the concatenation, not match each fragment.

  it('drops ALL incremental text fragments when the snapshot covers their concatenation (turn-level)', () => {
    // Two fragments at DISTINCT seqs (incremental, NOT coalesced in place).
    let push = emptyActivityState()
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 1, dispatchActivityTs: 10, dispatchTextDelta: 'Hello ' })
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 2, dispatchActivityTs: 20, dispatchTextDelta: 'world.' })

    // Snapshot has ONE finalized assistant message == concat of the two fragments.
    const snapshot: Message[] = [
      { id: 'm1', role: 'assistant', content: 'Hello world.', timestamp: 1 },
    ]

    const merged = reconcileActivity(snapshot, push)
    const textEntries = merged.filter((m) => m.role === 'assistant')
    // Exactly the snapshot's single message — no surviving fragment duplicates.
    // BEFORE the fix (exact equality): snapshot + 2 fragments = 3 assistant entries → red.
    expect(textEntries).toHaveLength(1)
    expect(textEntries[0].content).toBe('Hello world.')
  })

  it('preserves an in-flight run whose concatenation is NOT a prefix of any snapshot message (no false drop)', () => {
    // Snapshot caught up only to an earlier turn; the live run is newer.
    let push = emptyActivityState()
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 1, dispatchActivityTs: 30, dispatchTextDelta: 'Now checking ' })
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 2, dispatchActivityTs: 40, dispatchTextDelta: 'file sizes.' })

    const snapshot: Message[] = [
      { id: 'm1', role: 'assistant', content: 'Earlier finalized analysis.', timestamp: 1 },
    ]

    const merged = reconcileActivity(snapshot, push)
    const textEntries = merged.filter((m) => m.role === 'assistant')
    // Snapshot message + both surviving fragments (the run is genuinely newer).
    expect(textEntries.map((m) => m.content)).toEqual([
      'Earlier finalized analysis.',
      'Now checking ',
      'file sizes.',
    ])
  })

  it('interleaving: text fragments covered by snapshot drop while tools dedupe independently by id', () => {
    // push materialized order: text seq0 "A", tool t1, text seq2 "B".
    let push = emptyActivityState()
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 0, dispatchActivityTs: 10, dispatchTextDelta: 'A' })
    push = fold(push, { dispatchActivityKind: 'tool_start', dispatchSeq: 1, dispatchActivityTs: 20, toolId: 't1', toolName: 'Read' })
    push = fold(push, { dispatchActivityKind: 'text', dispatchSeq: 2, dispatchActivityTs: 30, dispatchTextDelta: 'B' })
    // A push tool t2 NOT in the snapshot must survive.
    push = fold(push, { dispatchActivityKind: 'tool_start', dispatchSeq: 3, dispatchActivityTs: 40, toolId: 't2', toolName: 'Bash' })

    // Snapshot: assistant "AB" (covers the text run) + tool t1.
    const snapshot: Message[] = [
      { id: 'm1', role: 'assistant', content: 'AB', timestamp: 1 },
      { id: 't1', role: 'tool', content: 'read result', toolId: 't1', toolName: 'Read', toolStatus: 'completed', timestamp: 2 },
    ]

    const merged = reconcileActivity(snapshot, push)
    // Both text fragments dropped (run covered by "AB").
    expect(merged.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(merged.filter((m) => m.role === 'assistant')[0].content).toBe('AB')
    // tool t1 deduped by id (one entry, the snapshot version).
    expect(merged.filter((m) => m.toolId === 't1')).toHaveLength(1)
    // tool t2 not in snapshot survives.
    expect(merged.filter((m) => m.toolId === 't2')).toHaveLength(1)
  })
})
