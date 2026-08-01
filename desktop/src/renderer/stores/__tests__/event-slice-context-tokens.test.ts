/**
 * Context-occupancy writes in the normalized event reducer.
 *
 * The reported bug: a conversation holding ~227k tokens rendered 0% in the
 * status bar. The desktop half of that was reading a numerator the engine
 * overwrote with a semantically different quantity, and preferring that live
 * value over the engine's authoritative status figure forever after.
 *
 * These tests pin the post-fix contract: the `usage` arm writes occupancy
 * onto the instance's statusFields (the single numerator the indicator
 * reads) AND mirrors it onto the tab (the carrier for the iOS snapshot,
 * which does not project per-instance statusFields), and the two never
 * disagree.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn((u: any) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn(() => ({ expandToolResults: false, aiGeneratedTitles: false, autoGroupMovement: false })) },
}))
vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import { activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

function buildHarness(statusFields: any = { label: '', state: 'running', model: '', contextPercent: 0, contextWindow: 1_000_000 }) {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'test-profile',
      status: 'running',
      lastEventAt: 0,
      permissionMode: 'auto',
      permissionDenied: null,
      contextTokens: null,
      contextWindow: null,
      hasUnread: false,
      queuedPrompts: [],
      historicalSessionIds: [],
      activeRequestId: null,
      currentActivity: null,
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{
      id: 'main', label: 'main', messages: [],
      messageCount: 0, modelOverride: null, sessionModel: null,
      permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
      conversationIds: [], draftInput: '', agentStates: [],
      statusFields, planFilePath: null, thinkingEffort: 'off', sealed: false,
    }], activeInstanceId: 'main' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

describe('usage arm writes occupancy to one place', () => {
  it('writes cache-aware occupancy onto statusFields and mirrors it to the tab', () => {
    const { state, slice } = buildHarness()

    // What the engine emits mid-run: input + cache_read + cache_creation,
    // already summed by the backend.
    slice.handleNormalizedEvent('tab1', {
      type: 'usage',
      usage: { input_tokens: 27_099, cache_read_input_tokens: 200_000, output_tokens: 326 },
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.statusFields?.contextTokens).toBe(227_099)
    // The tab mirror is the iOS snapshot carrier and must agree exactly.
    expect(state.tabs[0].contextTokens).toBe(227_099)
  })

  it('ignores a zero-token usage event rather than clearing a good figure', () => {
    const { state, slice } = buildHarness({
      label: '', state: 'running', model: '', contextPercent: 22, contextWindow: 1_000_000, contextTokens: 227_099,
    })

    slice.handleNormalizedEvent('tab1', {
      type: 'usage',
      usage: { input_tokens: 0, output_tokens: 0 },
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.statusFields?.contextTokens).toBe(227_099)
  })
})

/**
 * The `context_breakdown` event carries three different quantities, and only
 * some of them belong in the occupancy cell:
 *
 *   totalTokens      — the engine's ITEMIZED per-category sum. An independent
 *                      estimate (system + files + tools + conversation, each
 *                      counted separately), NOT a provider figure.
 *   apiReportedTotal — the provider's own input-token count, populated once the
 *                      engine reconciles the itemized sum against it.
 *   contextWindow    — the window of the model the engine actually ran.
 *
 * `totalTokens` must never be written to `statusFields.contextTokens`, whose
 * contract is provider-reported occupancy. It used to be, which made the
 * indicator flip between two different quantities depending on which event
 * landed last: a conversation the provider billed at 255,897 tokens was
 * itemized at 1,034,443, so the ring alternated between 26% and 103% of a 1M
 * window. `contextWindow` IS mirrored — the engine knows the real window and
 * that beats any client-side guess.
 */
describe('context_breakdown does not overwrite provider-reported occupancy', () => {
  it('leaves contextTokens at the usage figure when the itemized total arrives after it', () => {
    const { state, slice } = buildHarness()

    // The provider's own accounting for this turn.
    slice.handleNormalizedEvent('tab1', {
      type: 'usage',
      usage: { input_tokens: 2, output_tokens: 169, cache_read_input_tokens: 253_804, cache_creation_input_tokens: 2_091 },
    } as any)

    const inst0 = activeInstance(state.conversationPanes, 'tab1')
    expect(inst0?.statusFields?.contextTokens).toBe(255_897)

    // The engine's itemized sum for the same conversation — 4x larger, because
    // it counts content the provider never billed for this turn.
    slice.handleNormalizedEvent('tab1', {
      type: 'context_breakdown',
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 1_034_443,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.statusFields?.contextTokens).toBe(255_897)
    expect(state.tabs[0].contextTokens).toBe(255_897)
  })

  it('caches occupancyTokens so the drawer and bar read one engine figure', () => {
    // occupancyTokens is the engine's authoritative occupancy. Both surfaces
    // prefer it off the cached breakdown, so it has to survive the store write
    // — and it must stay distinct from the itemized totalTokens on the same
    // event, which is what previously reached the ring as 103%.
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'context_breakdown',
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 1_034_443,
      apiReportedTotal: 255_897,
      occupancyTokens: 255_897,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.contextBreakdown?.occupancyTokens).toBe(255_897)
    expect(inst?.contextBreakdown?.occupancyTokens).not.toBe(inst?.contextBreakdown?.totalTokens)
    // Still never written into the occupancy cell — the `usage` arm owns that,
    // and the engine derives both from the same call so they already agree.
    expect(inst?.statusFields?.contextTokens).not.toBe(1_034_443)
  })

  it('still mirrors the engine-reported window and caches the breakdown', () => {
    const { state, slice } = buildHarness()

    slice.handleNormalizedEvent('tab1', {
      type: 'context_breakdown',
      categories: [{ name: 'system', kind: 'system', tokens: 28_500, tier: 'local' }],
      contextWindow: 1_000_000,
      totalTokens: 1_034_443,
      apiReportedTotal: 255_897,
      unaccounted: -778_546,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // The window is a legitimate correction from the engine.
    expect(inst?.statusFields?.contextWindow).toBe(1_000_000)
    expect(state.tabs[0].contextWindow).toBe(1_000_000)
    // The breakdown itself is cached for the drawer, reconciled fields intact.
    expect(inst?.contextBreakdown?.totalTokens).toBe(1_034_443)
    expect(inst?.contextBreakdown?.apiReportedTotal).toBe(255_897)
    expect(inst?.contextBreakdown?.unaccounted).toBe(-778_546)
    expect(inst?.contextBreakdown?.categories).toHaveLength(1)
  })

  it('does not invent an occupancy figure when only a breakdown has arrived', () => {
    // No usage event: the itemized sum must not stand in for one.
    const { state, slice } = buildHarness({
      label: '', state: 'running', model: '', contextPercent: 0, contextWindow: 0, contextTokens: 0,
    })

    slice.handleNormalizedEvent('tab1', {
      type: 'context_breakdown',
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 1_034_443,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.statusFields?.contextTokens).toBe(0)
  })
})

/**
 * A fresh or just-reset instance has `statusFields: null` — that is its
 * initial value in conversation-instance.ts, and resetEngineInstance sets it
 * back. statusFields only becomes non-null when the `status` arm fires, so
 * every usage / context_breakdown event that arrives before the first
 * engine_status lands in this window.
 *
 * Both arms previously guarded on `if (inst0?.statusFields)`, so in that
 * window they wrote the tab mirror and DROPPED the instance write — and
 * StatusBarContextIndicator reads only inst.statusFields.contextTokens. The
 * indicator rendered nothing for the whole pre-first-status window while the
 * correct value sat on the tab: the same blank-indicator defect this file was
 * written to prevent, at a different entry condition.
 *
 * Every case above seeds a non-null statusFields, which is why the suite was
 * green while this was broken.
 */
describe('occupancy writes survive a null statusFields (pre-first-status window)', () => {
  it('usage synthesizes statusFields rather than dropping the write', () => {
    const { state, slice } = buildHarness(null)

    slice.handleNormalizedEvent('tab1', {
      type: 'usage',
      usage: { input_tokens: 27_099, output_tokens: 500, cache_read_input_tokens: 200_000 },
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    expect(inst?.statusFields?.contextTokens).toBe(227_099)
    // The tab mirror still agrees — the two must never disagree.
    expect(state.tabs[0].contextTokens).toBe(227_099)
  })

  it('context_breakdown synthesizes statusFields for the window it does own', () => {
    const { state, slice } = buildHarness(null)

    slice.handleNormalizedEvent('tab1', {
      type: 'context_breakdown',
      categories: [],
      contextWindow: 1_000_000,
      totalTokens: 228_500,
    } as any)

    const inst = activeInstance(state.conversationPanes, 'tab1')
    // The window write must not be dropped just because statusFields was null.
    expect(inst?.statusFields?.contextWindow).toBe(1_000_000)
    expect(state.tabs[0].contextWindow).toBe(1_000_000)
    // The itemized total is still not occupancy, even with nothing to overwrite.
    expect(inst?.statusFields?.contextTokens ?? 0).toBe(0)
  })
})
