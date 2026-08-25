/**
 * event-slice-error — handleErrorAction error-dedup contract.
 *
 * Pin the terminal Desktop-side enriched-error path in `handleErrorAction`
 * (`event-slice-error.ts`). A new enriched error appends an `Error: …` system
 * message and marks the local request failed. Engine `error` events use the
 * normalized reducer instead: they are visible signals, not lifecycle state.
 *
 * The duplicate window is positional, not temporal: it keys off whether the
 * LAST message is an error. An intervening non-error message re-opens the
 * window, so a genuinely distinct error (after other output) is not suppressed.
 */

import { describe, it, expect, vi } from 'vitest'

// Deterministic ids so appended messages are identifiable.
let idCounter = 0
vi.mock('../../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => `msg-${++idCounter}`),
}))

vi.mock('../event-slice-done-move', () => ({
  maybeScheduleDoneMove: vi.fn(),
}))

vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(),
  rWarn: vi.fn(),
}))

import { handleErrorAction } from '../event-slice-error'
import { handleTaskEvent } from '../event-slice-task'
import { seedMainPane, mainInstance } from '../../__tests__/helpers/conversation-test-helpers'
import type { EnrichedError } from '../../../../shared/types'
import type { Message } from '../../../../shared/types'

function makeTab() {
  return {
    id: 'tab1',
    title: 'T',
    engineProfileId: null,
    workingDirectory: '/tmp',
    hasChosenDirectory: true,
    pillIcon: null,
    groupId: null,
    groupPinned: false,
    status: 'running' as const,
    customTitle: null,
    pillColor: null,
    permissionMode: 'auto' as const,
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
    currentActivity: 'Working...',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
  }
}

function buildHarness(seedMessages: Message[] = []) {
  const state: any = {
    activeTabId: 'tab1',
    tabs: [makeTab()],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'auto',
      messages: seedMessages,
    }),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  return { state, set }
}

function makeError(message: string): EnrichedError {
  return {
    message,
    stderrTail: [],
    exitCode: 1,
    elapsedMs: 0,
    toolCallCount: 0,
    sawPermissionRequest: false,
  } as EnrichedError
}

function errorRows(messages: Message[]): Message[] {
  return messages.filter((m) => m.role === 'system' && m.content.startsWith('Error:'))
}

describe('event-slice-error — terminal enriched-error handling', () => {
  it('suppresses a duplicate error when the last message is already an error', () => {
    // First error appends an `Error:` row. A second error arriving immediately
    // after (the last message is still that error row) must be suppressed — the
    // instance keeps exactly one error row.
    const { state, set } = buildHarness()

    handleErrorAction(set, 'tab1', makeError('boom one'))
    const afterFirst = mainInstance(state.conversationPanes, 'tab1')!.messages
    expect(errorRows(afterFirst)).toHaveLength(1)
    expect(afterFirst[afterFirst.length - 1].content).toContain('boom one')

    handleErrorAction(set, 'tab1', makeError('boom two'))
    const afterSecond = mainInstance(state.conversationPanes, 'tab1')!.messages
    // Still ONE error row — the duplicate was suppressed.
    expect(errorRows(afterSecond)).toHaveLength(1)
    // The surviving row is the ORIGINAL error (the second was never appended).
    expect(afterSecond[afterSecond.length - 1].content).toContain('boom one')
    expect(afterSecond[afterSecond.length - 1].content).not.toContain('boom two')
    // Tab is marked failed and the active request cleared.
    expect(state.tabs[0].status).toBe('failed')
    expect(state.tabs[0].activeRequestId).toBeNull()
  })

  it('keeps a live run active when a normalized engine error arrives', () => {
    const { state, set } = buildHarness()
    const tab = state.tabs[0]
    const inst = mainInstance(state.conversationPanes, 'tab1')!
    const ctx: Parameters<typeof handleTaskEvent>[0] = {
      s: state,
      get: () => state,
      tabId: 'tab1',
      tab,
      inst0: inst,
      messages: inst.messages.slice(),
      permissionQueue: [{ id: 'permission-1' }],
      elicitationQueue: [{ id: 'elicitation-1' }],
      updated: { ...tab },
      instPatch: {},
      instTouched: false,
    }

    expect(handleTaskEvent(ctx, { type: 'error', message: 'compaction retry failed' })).toBe(true)

    set({
      tabs: [ctx.updated],
      conversationPanes: seedMainPane('tab1', {
        permissionMode: 'auto',
        messages: ctx.messages,
      }),
    })

    expect(state.tabs[0].status).toBe('running')
    expect(state.tabs[0].activeRequestId).toBe('req-1')
    expect(ctx.permissionQueue).toHaveLength(1)
    expect(ctx.elicitationQueue).toHaveLength(1)
    expect(ctx.instTouched).toBe(false)
    expect(mainInstance(state.conversationPanes, 'tab1')!.messages.at(-1)?.content).toContain('compaction retry failed')
  })

  it('does NOT suppress a distinct error when a non-error message intervenes', () => {
    // The dedup window is positional: it keys off whether the LAST message is an
    // error. When an assistant/user message follows the first error, the window
    // is re-opened, so a later error IS appended (two distinct error rows).
    const { state, set } = buildHarness()

    handleErrorAction(set, 'tab1', makeError('first failure'))
    expect(errorRows(mainInstance(state.conversationPanes, 'tab1')!.messages)).toHaveLength(1)

    // A non-error message arrives after the first error (e.g. a retry produced
    // assistant output), moving the error row out of the last position.
    const inst = mainInstance(state.conversationPanes, 'tab1')!
    inst.messages = [
      ...inst.messages,
      { id: 'assistant-1', role: 'assistant' as const, content: 'retrying…', timestamp: Date.now() },
    ]

    handleErrorAction(set, 'tab1', makeError('second failure'))
    const rows = errorRows(mainInstance(state.conversationPanes, 'tab1')!.messages)
    // Two distinct error rows: the second was NOT suppressed.
    expect(rows).toHaveLength(2)
    expect(rows[0].content).toContain('first failure')
    expect(rows[1].content).toContain('second failure')
  })
})
