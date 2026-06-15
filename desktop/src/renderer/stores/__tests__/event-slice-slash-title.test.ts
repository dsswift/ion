/**
 * event-slice — slash-command tab titling
 *
 * Pins the contract that when a conversation's first prompt is a slash
 * command, the LLM titling step is SKIPPED on task_complete so the tab keeps
 * the literal slash-command title that send-slice already set at send time
 * (truncated to the 40-char standard). The user must see exactly what command
 * was invoked, not an LLM interpretation of it.
 *
 * The two control cases (non-slash prose still triggers the LLM; whitespace
 * before the slash is still recognized) guard against the skip being too broad
 * or too narrow.
 *
 * Regression direction: with the fix reverted (the slash short-circuit
 * removed), the slash cases would call window.ion.generateTitle and these
 * tests would go red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'mock-msg-id'),
  playNotificationIfHidden: vi.fn(async () => {}),
  totalInputTokens: vi.fn(() => 0),
  scheduleDoneGroupMove: vi.fn(),
  cancelDoneGroupMove: vi.fn(() => false),
}))

// aiGeneratedTitles is ON for these tests so the title block runs; the slash
// short-circuit is what must suppress the LLM call, not the preference.
vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      expandToolResults: false,
      aiGeneratedTitles: true,
      autoGroupMovement: false,
      tabGroupMode: 'manual',
      doneGroupId: null,
      inProgressGroupId: null,
    }),
  },
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane } from './helpers/conversation-test-helpers'

beforeEach(() => {
  ;(globalThis as any).window = {
    ion: {
      // Resolve empty so renameTab is never invoked even if (wrongly) called.
      generateTitle: vi.fn(async () => ''),
      saveSessionLabel: vi.fn(async () => {}),
    },
  }
})

function makeTab(overrides: Record<string, any> = {}) {
  return {
    id: 'tab1',
    // send-slice sets this to the truncated first prompt at send time; for a
    // slash command it is the literal command text. The reducer must preserve
    // it unchanged when the first prompt is a slash command.
    title: '/clear arg',
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
    currentActivity: 'Working...',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
    ...overrides,
  }
}

function buildHarness(firstUserContent: string, tabTitle: string) {
  const state: any = {
    activeTabId: 'tab1',
    isExpanded: true,
    tabs: [makeTab({ title: tabTitle })],
    conversationPanes: seedMainPane('tab1', {
      permissionMode: 'plan',
      sessionModel: 'mock-model',
      messages: [
        { id: 'm1', role: 'user', content: firstUserContent, timestamp: 0 },
      ],
    }),
    backend: 'api',
    renameTab: vi.fn(),
    moveTabToGroup: vi.fn(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEventSlice(set, get) as State
  return { state, slice }
}

function fireTaskComplete(slice: State) {
  slice.handleNormalizedEvent!('tab1', {
    type: 'task_complete',
    result: 'done',
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    sessionId: 'conv-1',
  } as any)
}

describe('event-slice — slash-command tab titling', () => {
  it('skips LLM titling and preserves the literal title when first prompt is a slash command', () => {
    const { state, slice } = buildHarness('/clear arg', '/clear arg')

    fireTaskComplete(slice)

    // The LLM titling round-trip must NOT run for a slash command.
    expect((globalThis as any).window.ion.generateTitle).not.toHaveBeenCalled()
    // And the send-time literal title is untouched.
    expect(state.tabs[0].title).toBe('/clear arg')
    expect(state.renameTab).not.toHaveBeenCalled()
  })

  it('still runs LLM titling when the first prompt is plain prose', () => {
    const { slice } = buildHarness('please refactor the parser', 'please refactor the…')

    fireTaskComplete(slice)

    expect((globalThis as any).window.ion.generateTitle).toHaveBeenCalledTimes(1)
    expect((globalThis as any).window.ion.generateTitle).toHaveBeenCalledWith('please refactor the parser')
  })

  it('recognizes a slash command even with leading whitespace (trim) and skips LLM titling', () => {
    const { slice } = buildHarness('  /foo bar', '/foo bar')

    fireTaskComplete(slice)

    expect((globalThis as any).window.ion.generateTitle).not.toHaveBeenCalled()
  })

  it('skips LLM titling for a slash command with no arguments', () => {
    const { state, slice } = buildHarness('/clear', '/clear')

    fireTaskComplete(slice)

    expect((globalThis as any).window.ion.generateTitle).not.toHaveBeenCalled()
    expect(state.tabs[0].title).toBe('/clear')
  })
})
