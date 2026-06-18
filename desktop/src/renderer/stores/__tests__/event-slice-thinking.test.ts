/**
 * event-slice — extended-thinking dispatch (issue #158, plain-conversation path)
 *
 * Pins the PLAIN-conversation thinking reducer that runs through
 * event-slice.ts via `handleNormalizedEvent`. This is the bare-key twin of
 * engine-event-slice-thinking.test.ts (which covers the extension-hosted
 * compound-key path). The dispatch was extracted from three inline switch
 * cases into `handleThinkingEvent` (event-slice-thinking.ts) to keep
 * event-slice.ts under the 600-line cap; these tests pin that the extraction
 * is behavior-preserving end to end:
 *
 *   1. thinking_block_start opens an active thinking row.
 *   2. thinking_delta appends into the open row.
 *   3. thinking_block_end seals the row and stamps the summary fields.
 *   4. stream_reset (retry mid-thinking) discards ONLY a still-active thinking
 *      row; a sealed earlier row survives.
 *   5. a non-thinking event after a sealed thinking row leaves it intact
 *      (the guard returns the array unchanged → main switch handles the event).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => {
  let n = 0
  return {
    nextMsgId: vi.fn(() => `msg-${++n}`),
    playNotificationIfHidden: vi.fn(async () => {}),
    totalInputTokens: vi.fn(() => 0),
    scheduleDoneGroupMove: vi.fn(),
    cancelDoneGroupMove: vi.fn(() => false),
  }
})

vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      expandToolResults: false,
      aiGeneratedTitles: false,
      autoGroupMovement: false,
      tabGroupMode: 'manual',
      doneGroupId: null,
      inProgressGroupId: null,
    }),
  },
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'

function makeTab() {
  return {
    id: 'tab1',
    title: 'Engine',
    hasEngineExtension: false,
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: null,
    groupPinned: false,
    status: 'running' as const,
    customTitle: null,
    pillColor: null,
    permissionMode: 'plan' as const,
    queuedPrompts: [],
    historicalSessionIds: [],
    conversationId: 'conv-1',
    lastKnownSessionId: 'conv-1',
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: '',
    activeRequestId: 'req-1',
    currentActivity: 'Thinking...',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
  }
}

function buildHarness() {
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab()],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'plan',
      sessionModel: 'mock-model',
    }),
    backend: 'api',
    sendMessage: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function messages(state: any) {
  return mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
}

describe('event-slice — extended-thinking dispatch (plain path)', () => {
  it('thinking_block_start opens an active thinking row', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_start' } as any)

    const rows = messages(state).filter((m: any) => m.role === 'thinking')
    expect(rows).toHaveLength(1)
    expect(rows[0].thinkingActive).toBe(true)
    expect(rows[0].content).toBe('')
  })

  it('thinking_delta appends into the open thinking row', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_start' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_delta', text: 'Step 1. ' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_delta', text: 'Step 2.' } as any)

    const rows = messages(state).filter((m: any) => m.role === 'thinking')
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('Step 1. Step 2.')
    expect(rows[0].thinkingActive).toBe(true)
  })

  it('thinking_block_end seals the row and stamps summary fields', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_start' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_delta', text: 'reasoned' } as any)
    slice.handleNormalizedEvent!('tab1', {
      type: 'thinking_block_end',
      totalTokens: 123,
      elapsedSeconds: 4.5,
      redacted: false,
    } as any)

    const rows = messages(state).filter((m: any) => m.role === 'thinking')
    expect(rows).toHaveLength(1)
    expect(rows[0].thinkingActive).toBe(false)
    expect(rows[0].content).toBe('reasoned')
    expect(rows[0].thinkingTotalTokens).toBe(123)
    expect(rows[0].thinkingElapsedSeconds).toBe(4.5)
    expect(rows[0].thinkingRedacted).toBe(false)
  })

  it('stream_reset discards ONLY an active thinking row; a sealed row survives', () => {
    const { state, slice } = buildHarness()
    // First block: sealed (real history, must survive).
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_start' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_delta', text: 'first' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_end', elapsedSeconds: 1 } as any)
    // Second block: still active when the engine retries.
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_start' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_delta', text: 'second' } as any)

    expect(messages(state).filter((m: any) => m.role === 'thinking')).toHaveLength(2)

    slice.handleNormalizedEvent!('tab1', { type: 'stream_reset' } as any)

    const rows = messages(state).filter((m: any) => m.role === 'thinking')
    expect(rows).toHaveLength(1)
    expect(rows[0].thinkingActive).toBe(false)
    expect(rows[0].content).toBe('first')
  })

  it('a non-thinking event leaves a sealed thinking row intact', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_start' } as any)
    slice.handleNormalizedEvent!('tab1', { type: 'thinking_block_end', elapsedSeconds: 1 } as any)
    // A text_chunk is NOT a thinking event: handleThinkingEvent returns the
    // array unchanged and the main switch handles it. The sealed thinking row
    // must still be present afterwards.
    slice.handleNormalizedEvent!('tab1', { type: 'text_chunk', text: 'hello' } as any)

    const rows = messages(state).filter((m: any) => m.role === 'thinking')
    expect(rows).toHaveLength(1)
    expect(rows[0].thinkingActive).toBe(false)
  })
})
