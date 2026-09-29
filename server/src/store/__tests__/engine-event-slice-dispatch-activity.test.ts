/**
 * dispatch_activity rekeying — dispatchAgentId is the routing key
 *
 * Pins that:
 *   1. Two dispatch_activity streams sharing one convId but with distinct
 *      dispatchAgentIds produce separate push buffers in dispatchActivity.
 *      Neither buffer contains the other's entries.
 *   2. resolveDispatchData pattern: selecting dispatch 2 (same convId as
 *      dispatch 1) returns dispatch 2's push messages, not dispatch 1's.
 *   3. Events missing dispatchAgentId are dropped (no store mutation).
 *
 * Reverting the dispatchAgentId-keying in engine-event-slice-messages.ts turns
 * tests 1 and 2 red, which is what keeps the convId-collision bug fixed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false })) },
}))

import { handleCrossNormalizedEvent } from '../slices/engine-event-slice-messages'
import { dispatchActivityFoldByDispatchId } from '../slices/engine-event-slice-helpers'
import type { State } from '../session-store-types'

function buildHarness() {
  const state: any = {
    dispatchActivity: {} as Record<string, any[]>,
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  return { state, set, get }
}

function textEvent(dispatchAgentId: string, dispatchConversationId: string, seq: number, text: string) {
  return {
    type: 'dispatch_activity' as const,
    dispatchAgentId,
    dispatchConversationId,
    dispatchActivityKind: 'text' as const,
    dispatchSeq: seq,
    dispatchTextDelta: text,
    dispatchToolIsError: false,
    dispatchActivityTs: '2025-01-01T00:00:00Z',
  } as any
}

function toolEvent(dispatchAgentId: string, kind: 'tool_start' | 'tool_end', seq: number, toolId: string, toolName?: string) {
  return {
    type: 'dispatch_activity' as const,
    dispatchAgentId,
    dispatchConversationId: 'shared-conv',
    dispatchActivityKind: kind,
    dispatchSeq: seq,
    toolId,
    toolName,
    dispatchToolIsError: false,
    dispatchActivityTs: '2025-01-01T00:00:00Z',
  } as any
}

describe('dispatch_activity rekeying by dispatchAgentId', () => {
  beforeEach(() => {
    // Clear the module-level fold map between tests so they don't bleed.
    dispatchActivityFoldByDispatchId.clear()
  })

  it('two streams sharing one convId get separate push buffers keyed by dispatchAgentId', () => {
    const { state, set, get } = buildHarness()

    // Dispatch A — seq 1, text "from A"
    handleCrossNormalizedEvent(set, get, 'tab1', textEvent('id-A', 'shared-conv', 1, 'from A'))

    // Dispatch B — seq 1 (same seq, same convId), text "from B"
    handleCrossNormalizedEvent(set, get, 'tab1', textEvent('id-B', 'shared-conv', 1, 'from B'))

    const bufferA = state.dispatchActivity['id-A'] ?? []
    const bufferB = state.dispatchActivity['id-B'] ?? []

    expect(bufferA.length).toBe(1)
    expect(bufferB.length).toBe(1)

    // Neither buffer contains the other's entry.
    expect(bufferA.some((m: any) => m.content === 'from B')).toBe(false)
    expect(bufferB.some((m: any) => m.content === 'from A')).toBe(false)

    expect(bufferA[0].content).toBe('from A')
    expect(bufferB[0].content).toBe('from B')
  })

  it('multiple events for the same dispatchAgentId accumulate in one buffer', () => {
    const { state, set, get } = buildHarness()

    handleCrossNormalizedEvent(set, get, 'tab1', toolEvent('id-A', 'tool_start', 1, 'tool-1', 'Read'))
    handleCrossNormalizedEvent(set, get, 'tab1', toolEvent('id-A', 'tool_end', 2, 'tool-1'))
    handleCrossNormalizedEvent(set, get, 'tab1', textEvent('id-A', 'shared-conv', 3, 'analysis done'))

    const bufferA = state.dispatchActivity['id-A'] ?? []
    const tools = bufferA.filter((m: any) => m.role === 'tool')
    const texts = bufferA.filter((m: any) => m.role === 'assistant')

    // tool_start + tool_end collapse to one entry.
    expect(tools.length).toBe(1)
    expect(texts.length).toBe(1)
    expect(texts[0].content).toBe('analysis done')
  })

  it('resolveDispatchData pattern: dispatch 2 lookup returns dispatch 2 push messages', () => {
    // Simulates what AgentPanel.resolveDispatchData does:
    // dispatchActivity[activeDispatch.id] not dispatchActivity[activeConvId].
    const { state, set, get } = buildHarness()

    // Dispatch 1 push messages.
    handleCrossNormalizedEvent(set, get, 'tab1', textEvent('dispatch-1', 'shared-conv', 1, 'dispatch 1 output'))

    // Dispatch 2 push messages (same convId, different dispatchAgentId).
    handleCrossNormalizedEvent(set, get, 'tab1', textEvent('dispatch-2', 'shared-conv', 1, 'dispatch 2 output'))

    // Simulate AgentPanel selecting dispatch 2 and reading its push buffer by id.
    const pushMsgs = state.dispatchActivity['dispatch-2'] ?? []
    expect(pushMsgs.length).toBe(1)
    expect(pushMsgs[0].content).toBe('dispatch 2 output')

    // Selecting dispatch 1's id returns dispatch 1's buffer, not dispatch 2's.
    const dispatch1Msgs = state.dispatchActivity['dispatch-1'] ?? []
    expect(dispatch1Msgs.length).toBe(1)
    expect(dispatch1Msgs[0].content).toBe('dispatch 1 output')
  })

  it('drops events missing dispatchAgentId and does not mutate dispatchActivity', () => {
    const { state, set, get } = buildHarness()

    const before = { ...state.dispatchActivity }

    handleCrossNormalizedEvent(set, get, 'tab1', {
      type: 'dispatch_activity',
      // No dispatchAgentId
      dispatchConversationId: 'conv-x',
      dispatchActivityKind: 'text',
      dispatchSeq: 1,
      dispatchTextDelta: 'should be dropped',
    } as any)

    expect(state.dispatchActivity).toEqual(before)
  })
})
