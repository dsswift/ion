/**
 * Live-vs-hydrated transcript parity (the "89 vs 53+26 tools" class).
 *
 * The SAME conversation must produce the SAME grouped transcript whether it
 * was built live (normalized events through the event-slice reducer) or
 * hydrated from engine history (SessionLoadMessage rows through
 * mapSessionHistory). Before this fix the two diverged two ways:
 *
 *   1. `text_chunk` appended across a `sealed` row, merging separate
 *      persisted assistant messages into one paragraph live (history renders
 *      one row per entry text block) — the merged-paragraph divergence.
 *   2. Live rows carried local counter ids while history rows minted fresh
 *      ids per load, so no row of one build shared identity with the other.
 *
 * With sealed-aware chunk handling, toolId-keyed tool rows, and message_end
 * entry-id re-keying, both builds converge on identical ids AND identical
 * grouped shape.
 */

import { describe, it, expect, vi } from 'vitest'

let seq = 0
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: vi.fn(() => `local-${seq++}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn((u: any) => u?.input_tokens ?? 0),
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
import { mapSessionHistory } from '../../../shared/session-message-mapper'
import { groupMessages } from '../../components/conversation/tool-helpers'
import type { State } from '../session-store-types'
import type { SessionLoadMessage, NormalizedEvent } from '../../../shared/types'

function buildHarness(initialMessages: any[]) {
  const state: any = {
    tabs: [{
      id: 'tab1',
      engineProfileId: 'test-profile',
      status: 'running',
      lastEventAt: 0,
      permissionMode: 'auto',
      permissionDenied: null,
      contextTokens: 0,
      contextPercent: 0,
      hasUnread: false,
      queuedPrompts: [],
      historicalSessionIds: [],
      activeRequestId: null,
      currentActivity: 'Writing...',
    }],
    activeTabId: 'tab1',
    isExpanded: false,
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [{
      id: 'main', label: 'main', messages: initialMessages,
      messageCount: initialMessages.length, modelOverride: null, sessionModel: null,
      permissionMode: 'auto', permissionDenied: null, permissionQueue: [], elicitationQueue: [],
      conversationIds: [], draftInput: '', agentStates: [],
      statusFields: null, planFilePath: null, thinkingEffort: 'off', sealed: false,
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

/** Grouped shape summary: kind plus tool tally per group. */
function shape(messages: any[]): string[] {
  return groupMessages(messages, { includeUser: true }).map((g: any) => {
    if (g.kind === 'tool-group') return `tool-group(${g.messages.length})`
    return g.kind
  })
}

describe('live-built vs history-hydrated transcript parity', () => {
  it('same conversation groups identically and shares row ids', () => {
    // ── Live build: optimistic user row, then the normalized stream ──
    const { state, slice } = buildHarness([
      { id: 'local-user', role: 'user', content: 'do the thing', timestamp: 1 },
    ])

    // Event order matches the engine: the stream ends (text + tool_use),
    // message_end fires with the pre-minted entry ids, THEN tool results
    // arrive, then the next assistant message streams.
    const events: NormalizedEvent[] = [
      { type: 'text_chunk', text: 'Let me check.' },
      { type: 'tool_call', toolName: 'Bash', toolId: 'toolu_1' },
      { type: 'tool_call_complete', index: 0 },
      // End of assistant message 1: seal + canonical re-key.
      { type: 'message_end', inputTokens: 10, outputTokens: 5, entryId: 'e1', userEntryId: 'u1' },
      { type: 'tool_result', toolId: 'toolu_1', content: 'ok', isError: false },
      { type: 'text_chunk', text: 'Found it.' },
      { type: 'message_end', inputTokens: 12, outputTokens: 3, entryId: 'e2', userEntryId: 'u1' },
    ] as NormalizedEvent[]
    for (const ev of events) {
      ;(slice as any).handleNormalizedEvent('tab1', ev)
    }
    const live = activeInstance(state.conversationPanes, 'tab1')!.messages

    // ── Hydrated build: the engine history rows for the same conversation ──
    const history: SessionLoadMessage[] = [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'e1', role: 'assistant', content: 'Let me check.', timestamp: 2 },
      { id: 'e1:1', role: 'tool', content: 'ok', toolName: 'Bash', toolId: 'toolu_1', toolInput: '', timestamp: 2 },
      { id: 'e2', role: 'assistant', content: 'Found it.', timestamp: 3 },
    ]
    const hydrated = mapSessionHistory(history, () => `fallback-${seq++}`)

    // Grouped shape parity — the exact property that diverged in production
    // (one merged paragraph + differently-cut tool groups after hydration).
    expect(shape(live)).toEqual(shape(hydrated))
    expect(shape(live)).toEqual(['user', 'assistant', 'tool-group(1)', 'assistant'])

    // Row-id parity: every row of one build exists in the other.
    expect(live.map((m: any) => m.id)).toEqual(hydrated.map((m) => m.id))

    // Content parity: the sealed boundary kept the two assistant messages
    // separate on the live build.
    expect(live.map((m: any) => m.content)).toEqual(hydrated.map((m) => m.content))
  })

  it('text_chunk after a sealed row opens a new assistant message', () => {
    const { state, slice } = buildHarness([
      { id: 'e1', role: 'assistant', content: 'first message', timestamp: 1, sealed: true },
    ])
    ;(slice as any).handleNormalizedEvent('tab1', { type: 'text_chunk', text: 'second message' })
    const msgs = activeInstance(state.conversationPanes, 'tab1')!.messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('first message')
    expect(msgs[1].content).toBe('second message')
  })
})
