/**
 * `command_result{command:"clear"}` must invalidate the cached contextBreakdown.
 *
 * The reported bug: running `/squash` (a `clears-conversation` command)
 * immediately after a manual `/clear` still prompted "Clear the conversation
 * first?" — the confirmation gate (InputBarClearingCommand.ts `hasHistory`)
 * reads `resolveContextInputs`, which prefers a cached
 * `contextBreakdown.occupancyTokens` over `statusFields.contextTokens`. The
 * engine's clear signal (emitClearSignal) resets `statusFields.contextTokens`
 * to 0 but never refreshes `contextBreakdown` — it is a client-side cache
 * populated on demand by the `context_breakdown` event, which /clear does not
 * re-fire. A breakdown cached before the clear kept reporting the pre-clear
 * token count as truth, so the gate treated an already-empty conversation as
 * still holding history.
 *
 * This test pins that `handleCrossNormalizedEvent` nulls the cached
 * contextBreakdown on a successful clear result, alongside the existing
 * divider insertion and permissionDenied reset.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
}))

import { handleCrossNormalizedEvent } from '../slices/engine-event-slice-messages'
import { makeMainPane } from '../conversation-instance'
import type { ConversationPane } from '../../../shared/types-engine'
import type { State } from '../session-store-types'

function buildHarness(contextBreakdown: NonNullable<ReturnType<typeof makeMainPane>['instances'][number]['contextBreakdown']>) {
  const pane: ConversationPane = makeMainPane({
    statusFields: { label: '', state: 'idle', model: '', contextPercent: 0, contextWindow: 1_000_000, contextTokens: 0 },
    contextBreakdown,
  })
  const state = {
    conversationPanes: new Map([['tab1', pane]]),
  } as State
  const set = (partial: Partial<State> | ((s: State) => Partial<State>)) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state
  return { state, set, get }
}

describe('command_result clear invalidates the cached contextBreakdown', () => {
  it('nulls contextBreakdown.occupancyTokens so a stale figure cannot outlive the clear', () => {
    const { state, set, get } = buildHarness({
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 227_099,
      occupancyTokens: 227_099,
      model: '',
    })

    handleCrossNormalizedEvent(set, get, 'tab1', { type: 'command_result', command: 'clear' } as any)

    const inst = state.conversationPanes!.get('tab1')!.instances[0]
    expect(inst.contextBreakdown).toBeNull()
  })

  it('still inserts the divider and clears permissionDenied (unchanged behavior)', () => {
    const { state, set, get } = buildHarness({
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 100,
      occupancyTokens: 100,
      model: '',
    })

    handleCrossNormalizedEvent(set, get, 'tab1', { type: 'command_result', command: 'clear' } as any)

    const inst = state.conversationPanes!.get('tab1')!.instances[0]
    expect(inst.messages.at(-1)?.content).toMatch(/^── Cleared at/)
    expect(inst.permissionDenied).toBeNull()
  })

  it('leaves contextBreakdown alone on a failed clear result', () => {
    const { state, set, get } = buildHarness({
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 227_099,
      occupancyTokens: 227_099,
      model: '',
    })

    handleCrossNormalizedEvent(set, get, 'tab1', { type: 'command_result', command: 'clear', commandError: 'boom' } as any)

    const inst = state.conversationPanes!.get('tab1')!.instances[0]
    expect(inst.contextBreakdown?.occupancyTokens).toBe(227_099)
  })
})
