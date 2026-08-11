/**
 * prompt_injected — extension-injected prompts render as live user turns.
 *
 * An extension calling ctx.sendPrompt (dispatch-completion delivery,
 * check-ins, revives) starts a run whose user turn NO client submitted, so
 * no client did an optimistic insert. Before the engine emitted
 * engine_prompt_injected, the turn existed only in the conversation file —
 * the ATV (which rehydrates from disk) showed "[Agent X completed in Ns]"
 * turns the live overlay never displayed. This pins the reducer arm: the
 * event appends the prompt as a user message, verbatim.
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

vi.mock('../slices/engine-event-slice-messages', () => ({
  handleCrossNormalizedEvent: vi.fn(() => false),
}))

import { createEventSlice } from '../slices/event-slice'
import type { State } from '../session-store-types'
import { seedMainPane, mainInstance } from './helpers/conversation-test-helpers'
import { isSteerAppliedDivider } from '../../../shared/clear-divider'

function buildHarness() {
  const state: any = {
    activeTabId: 'tab1',
    tabs: [{
      id: 'tab1', title: 'Test Tab', engineProfileId: 'p', workingDirectory: '/tmp',
      hasChosenDirectory: true, pillIcon: null, groupId: null, groupPinned: false,
      status: 'running' as const, customTitle: null, pillColor: null,
      queuedPrompts: [], historicalSessionIds: [], conversationId: 'conv-1',
      lastKnownSessionId: 'conv-1', lastResult: null, sessionTools: [],
      sessionMcpServers: [], sessionSkills: [], sessionVersion: '',
      activeRequestId: 'req-1', currentActivity: '', lastEventAt: 0,
      isCompacting: false, hasUnread: false, attachments: [],
      contextTokens: 0, contextPercent: 0,
    }],
    conversationPanes: seedMainPane('tab1', { messages: [] }),
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineModelFallbacks: new Map(),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const slice = createEventSlice(set, () => state as State) as State
  return { state, slice }
}

describe('prompt_injected reducer arm', () => {
  it('appends the injected prompt as a user message, verbatim', () => {
    const { state, slice } = buildHarness()
    const text = '[Agent Dev Lead completed in 26s]\ndesktop-dev running. Holding for completion.'
    slice.handleNormalizedEvent('tab1', { type: 'prompt_injected', prompt: text, origin: 'ion-dev' } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe(text)
  })

  // kind="slash_command" is the expanded body of a slash command whose display
  // turn is the command pill. Rendering it would put the whole multi-KB command
  // template on screen as a second user message (the /align wall-of-text
  // regression). The reducer must suppress it; the pill comes from the optimistic
  // insert + persisted display entry, not from this event.
  it('suppresses a slash_command-kind injection (no second bubble)', () => {
    const { state, slice } = buildHarness()
    const expandedBody = 'You are running the /align command. '.repeat(500)
    slice.handleNormalizedEvent('tab1', {
      type: 'prompt_injected', prompt: expandedBody, origin: 'ion-dev', kind: 'slash_command',
    } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs).toHaveLength(0)
  })

  // agent_completion (machine-to-machine dispatch callback) stays suppressed —
  // regression guard alongside the new slash_command case.
  it('suppresses an agent_completion-kind injection', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'prompt_injected', prompt: 'child result body', origin: 'ion-dev', kind: 'agent_completion',
    } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs).toHaveLength(0)
  })

  // background_task_completion — a finished background bash command's result
  // routed back to wake a parked session (ADR-023). Machine-to-machine like
  // agent_completion: the engine is reporting an exit code and output tail to
  // the model, so rendering it puts raw command output in the transcript as a
  // user bubble. Observed live before this was suppressed.
  it('suppresses a background_task_completion-kind injection', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'prompt_injected',
      prompt: 'Background command bash-1 (failed).\nExit code: 7\nRecent output:\nboom',
      origin: '',
      kind: 'background_task_completion',
    } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs).toHaveLength(0)
  })

  // An empty kind is a genuine extension-initiated user turn (check-in, revive)
  // and must still render — the suppression is scoped to classified injections.
  it('renders an empty-kind injection as a user message', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'prompt_injected', prompt: 'please continue', origin: 'ion-dev', kind: '',
    } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('please continue')
  })

  // A degraded ctx.steerSelf delivery (no live run, so it became a fresh
  // prompt) carries the caller's kind — `checkin` for a heartbeat — and is
  // suppressed as the machine turn it is. The DIVIDER for it does not come from
  // this arm: the engine emits `steer_degraded` alongside, handled separately. This
  // is the reported defect's regression guard — it must never render as a user
  // bubble.
  it('suppresses a degraded self-steer turn, leaving the divider to steer_degraded', () => {
    const { state, slice } = buildHarness()
    slice.handleNormalizedEvent('tab1', {
      type: 'prompt_injected',
      prompt: '[SYSTEM] Dispatch check-in\n\nYou have been idle for ~10 minutes.',
      origin: 'ion-dev',
      kind: 'checkin',
      machineAuthored: true,
    } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs.filter((m: any) => m.role === 'user')).toHaveLength(0)
    expect(msgs).toHaveLength(0)
  })

  // The divider itself, from the event the engine emits on the degraded arm.
  // Together with the test above this pins the full rendering: one divider,
  // zero user bubbles.
  it('renders a degraded self-steer divider without resolving a pending bubble', () => {
    const { state, slice } = buildHarness()
    state.conversationPanes.get('tab1')!.instances[0].messages = [{
      id: 'pending', role: 'user', content: 'user steer', timestamp: Date.now(), steerPending: true,
    }] as any
    slice.handleNormalizedEvent('tab1', { type: 'steer_degraded', messageLength: 42 } as any)

    const msgs = mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
    expect(msgs).toHaveLength(2)
    expect(msgs[0].steerPending).toBe(true)
    expect(msgs[0].steerApplied).toBeUndefined()
    expect(msgs[1].role).toBe('system')
    expect(isSteerAppliedDivider(msgs[1].content)).toBe(true)
  })
})
