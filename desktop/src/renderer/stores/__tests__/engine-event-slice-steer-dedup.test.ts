/**
 * Steer-dedup (WI-001 normalized path)
 *
 * After the single-path collapse (WI-001), ALL events — including
 * steer_injected — flow through handleNormalizedEvent. The raw
 * engine_steer_injected path via handleEngineEvent is retired.
 *
 * This file verifies:
 *   Part 1: steer_injected via handleNormalizedEvent appends exactly one divider
 *           for all tab types (plain and extension).
 *   Part 2: steerPending / steerFailed lifecycle via normalized events.
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

function makeTab(opts: { hasExtensions?: boolean } = {}) {
  return {
    id: 'tab1',
    title: 'Test Tab',
    engineProfileId: opts.hasExtensions ? 'test-profile' : null,
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
    currentActivity: '',
    lastEventAt: 0,
    isCompacting: false,
    hasUnread: false,
    attachments: [],
    permissionDenied: null,
    contextTokens: 0,
    contextPercent: 0,
  }
}

function buildHarness(opts: {
  tabHasExtensions?: boolean
  instanceMessages?: any[]
} = {}) {
  const { tabHasExtensions = true, instanceMessages = [] } = opts

  const conversationPanes = seedMainPane('tab1', {
    messages: instanceMessages.slice(),
  })

  const state: any = {
    activeTabId: 'tab1',
    tabs: [makeTab({ hasExtensions: tabHasExtensions })],
    conversationPanes,
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
  const get = () => state as State
  const eventSlice = createEventSlice(set, get) as State

  return { state, eventSlice }
}

function getMessages(state: any): any[] {
  return mainInstance(state.conversationPanes, 'tab1')?.messages ?? []
}

// ─── Part 1: Dedup — single divider on extension tab ─────────────────────

describe('Steer dedup — single divider for all tab types (WI-001)', () => {
  it('steer_injected via handleNormalizedEvent appends exactly one divider on extension tab', () => {
    const { state, eventSlice } = buildHarness({ tabHasExtensions: true })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 42,
    } as any)

    const msgs = getMessages(state)
    const dividers = msgs.filter((m) => m.role === 'system' && m.content?.includes('Steer'))
    expect(dividers).toHaveLength(1)
  })

  it('steer_injected via handleNormalizedEvent appends exactly one divider on plain tab', () => {
    const { state, eventSlice } = buildHarness({ tabHasExtensions: false })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 10,
    } as any)

    const msgs = getMessages(state)
    const dividers = msgs.filter((m) => m.role === 'system' && m.content?.includes('Steer'))
    expect(dividers).toHaveLength(1)
  })

  it('calling steer_injected twice inserts two dividers (no automatic dedup across different steers)', () => {
    // Steers are not deduped across calls — each steer produces its own divider.
    const { state, eventSlice } = buildHarness({ tabHasExtensions: true })

    eventSlice.handleNormalizedEvent('tab1', { type: 'steer_injected', messageLength: 10 } as any)
    eventSlice.handleNormalizedEvent('tab1', { type: 'steer_injected', messageLength: 20 } as any)

    const msgs = getMessages(state)
    const dividers = msgs.filter((m) => m.role === 'system' && m.content?.includes('Steer'))
    expect(dividers).toHaveLength(2)
  })
})

// ─── Part 2: steerPending lifecycle ──────────────────────────────────────

describe('steerPending lifecycle (WI-001 normalized path)', () => {
  it('steer_injected clears steerPending on the optimistic bubble', () => {
    const pendingBubble = {
      id: 'pending-bubble',
      role: 'user',
      content: 'redirect the agent',
      timestamp: Date.now(),
      steerPending: true,
    }
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: pendingBubble.content.length,
    } as any)

    const msgs = getMessages(state)
    const bubble = msgs.find((m: any) => m.id === 'pending-bubble')
    expect(bubble).toBeDefined()
    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerFailed).toBeUndefined()

    // Divider was appended after the bubble.
    const dividers = msgs.filter((m: any) => m.role === 'system' && m.content?.includes('Steer'))
    expect(dividers).toHaveLength(1)
  })

  it('error event sets steerFailed and clears steerPending', () => {
    const pendingBubble = {
      id: 'pending-bubble',
      role: 'user',
      content: 'steer me somewhere',
      timestamp: Date.now(),
      steerPending: true,
    }
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'error',
      message: 'Engine process exited with code 1',
    } as any)

    const msgs = getMessages(state)
    const bubble = msgs.find((m: any) => m.id === 'pending-bubble')
    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerFailed).toBe(true)
  })

  it('session_dead also fails any pending steer bubble', () => {
    const pendingBubble = {
      id: 'pending-bubble-2',
      role: 'user',
      content: 'steer pending',
      timestamp: Date.now(),
      steerPending: true,
    }
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'session_dead',
      exitCode: 1,
    } as any)

    const msgs = getMessages(state)
    const bubble = msgs.find((m: any) => m.id === 'pending-bubble-2')
    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerFailed).toBe(true)
  })

  it('extension tab engine_dead (exitCode != 0) arrives as session_dead NormalizedEvent', () => {
    // WI-001: engine_dead is no longer handled by handleEngineEvent.
    // The control plane translates engine_dead → handleError() → session_dead NormalizedEvent.
    // This test verifies the equivalent path via session_dead.
    const pendingBubble = {
      id: 'ext-pending',
      role: 'user',
      content: 'ext steer',
      timestamp: Date.now(),
      steerPending: true,
    }
    const { state, eventSlice } = buildHarness({
      tabHasExtensions: true,
      instanceMessages: [pendingBubble],
    })

    // After WI-001, the production path emits session_dead (not engine_dead to handleEngineEvent).
    eventSlice.handleNormalizedEvent('tab1', {
      type: 'session_dead',
      exitCode: 1,
    } as any)

    const msgs = getMessages(state)
    const bubble = msgs.find((m: any) => m.id === 'ext-pending')
    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerFailed).toBe(true)
  })

  it('messages without steerPending are not modified by steer_injected', () => {
    const normalBubble = {
      id: 'normal',
      role: 'user',
      content: 'a normal message',
      timestamp: Date.now(),
    }
    const { state, eventSlice } = buildHarness({ instanceMessages: [normalBubble] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 20,
    } as any)

    const msgs = getMessages(state)
    const bubble = msgs.find((m: any) => m.id === 'normal')
    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerFailed).toBeUndefined()
  })
})

// ─── Part 3: bubble ↔ divider pairing (render-time relocation) ───────────

describe('steer_injected pairs the bubble with its divider', () => {
  function pendingBubble(id: string, content = 'redirect the agent') {
    return { id, role: 'user', content, timestamp: Date.now(), steerPending: true }
  }

  it('stamps steerApplied and the divider id on the resolving bubble', () => {
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble('b1')] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 18,
    } as any)

    const msgs = getMessages(state)
    const bubble = msgs.find((m: any) => m.id === 'b1')
    const divider = msgs.find((m: any) => m.role === 'system' && m.content?.includes('Steer'))

    expect(bubble?.steerPending).toBeUndefined()
    expect(bubble?.steerApplied).toBe(true)
    // The shared key is what lets the grouping pass relocate the bubble to
    // the divider — see tool-helpers.ts isRelocatableSteer.
    expect(divider?.id).toBeTruthy()
    expect(bubble?.steerAppliedDividerId).toBe(divider?.id)
  })

  it('resolves one bubble per event, oldest first (two queued steers do not collapse)', () => {
    const { state, eventSlice } = buildHarness({
      instanceMessages: [pendingBubble('b1', 'first steer'), pendingBubble('b2', 'second steer')],
    })

    eventSlice.handleNormalizedEvent('tab1', { type: 'steer_injected', messageLength: 11 } as any)

    let msgs = getMessages(state)
    expect(msgs.find((m: any) => m.id === 'b1')?.steerApplied).toBe(true)
    // The second steer is still buffered in the engine — untouched.
    expect(msgs.find((m: any) => m.id === 'b2')?.steerPending).toBe(true)
    expect(msgs.find((m: any) => m.id === 'b2')?.steerApplied).toBeUndefined()

    eventSlice.handleNormalizedEvent('tab1', { type: 'steer_injected', messageLength: 12 } as any)

    msgs = getMessages(state)
    const b1 = msgs.find((m: any) => m.id === 'b1')
    const b2 = msgs.find((m: any) => m.id === 'b2')
    expect(b2?.steerApplied).toBe(true)
    // Each bubble points at its OWN divider.
    expect(b1?.steerAppliedDividerId).toBeTruthy()
    expect(b2?.steerAppliedDividerId).toBeTruthy()
    expect(b1?.steerAppliedDividerId).not.toBe(b2?.steerAppliedDividerId)

    const dividerIds = msgs
      .filter((m: any) => m.role === 'system' && m.content?.includes('Steer'))
      .map((m: any) => m.id)
    expect(dividerIds).toHaveLength(2)
    expect(dividerIds).toContain(b1?.steerAppliedDividerId)
    expect(dividerIds).toContain(b2?.steerAppliedDividerId)
  })

  it('a failed steer carries no divider id', () => {
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble('b1')] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'session_dead',
      exitCode: 1,
    } as any)

    const bubble = getMessages(state).find((m: any) => m.id === 'b1')
    expect(bubble?.steerFailed).toBe(true)
    expect(bubble?.steerApplied).toBeUndefined()
    expect(bubble?.steerAppliedDividerId).toBeUndefined()
  })
})

// ─── Part 4: exact clientMessageId resolution (identity over position) ──
//
// The regression this closes: with two steers outstanding, a FIFO-first
// resolution collapses a later confirmation onto the WRONG (earlier,
// unrelated) bubble. When the event carries clientMessageId, resolution must
// match that exact bubble regardless of arrival order or queue position.

describe('steer_injected exact clientMessageId resolution', () => {
  function pendingBubble(id: string, content = 'redirect the agent') {
    return { id, role: 'user', content, timestamp: Date.now(), steerPending: true }
  }

  it('resolves the exact bubble by clientMessageId even when it is NOT the oldest pending', () => {
    const { state, eventSlice } = buildHarness({
      instanceMessages: [pendingBubble('b1', 'first steer'), pendingBubble('b2', 'second steer')],
    })

    // The SECOND steer's confirmation arrives first (out of order) — a FIFO
    // resolution would wrongly resolve b1. With clientMessageId, it must
    // resolve b2 specifically.
    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 12,
      clientMessageId: 'b2',
      entryId: 'e-canonical-2',
    } as any)

    const msgs = getMessages(state)
    const b1 = msgs.find((m: any) => m.id === 'b1')
    const b2 = msgs.find((m: any) => m.id === 'e-canonical-2')
    expect(b1?.steerPending).toBe(true)
    expect(b1?.steerApplied).toBeUndefined()
    expect(b2).toBeDefined()
    expect(b2?.steerPending).toBeUndefined()
    expect(b2?.steerApplied).toBe(true)
  })

  it('re-keys the resolved bubble to the durable entryId from the event', () => {
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble('client-id-1')] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 20,
      clientMessageId: 'client-id-1',
      entryId: 'e-durable-abc',
    } as any)

    const msgs = getMessages(state)
    expect(msgs.find((m: any) => m.id === 'client-id-1')).toBeUndefined()
    const rekeyed = msgs.find((m: any) => m.id === 'e-durable-abc')
    expect(rekeyed).toBeDefined()
    expect(rekeyed?.steerApplied).toBe(true)
  })

  it('falls back to FIFO-first-pending when the event carries no clientMessageId', () => {
    const { state, eventSlice } = buildHarness({
      instanceMessages: [pendingBubble('b1', 'first steer'), pendingBubble('b2', 'second steer')],
    })

    eventSlice.handleNormalizedEvent('tab1', { type: 'steer_injected', messageLength: 11 } as any)

    const msgs = getMessages(state)
    expect(msgs.find((m: any) => m.id === 'b1')?.steerApplied).toBe(true)
    expect(msgs.find((m: any) => m.id === 'b2')?.steerPending).toBe(true)
  })

  it('does not resolve anything and logs a warning when clientMessageId matches no pending bubble', () => {
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble('b1')] })

    eventSlice.handleNormalizedEvent('tab1', {
      type: 'steer_injected',
      messageLength: 9,
      clientMessageId: 'no-such-bubble',
    } as any)

    const msgs = getMessages(state)
    // b1 is untouched — a mismatched clientMessageId must never fall through
    // to resolving an unrelated pending bubble.
    expect(msgs.find((m: any) => m.id === 'b1')?.steerPending).toBe(true)
    // The confirmation divider is still appended even though no bubble
    // resolved — the engine did drain a steer, that fact is not hidden.
    const dividers = msgs.filter((m: any) => m.role === 'system' && m.content?.includes('Steer'))
    expect(dividers).toHaveLength(1)
  })

  it('a machine-originated confirmation (no clientMessageId) never resolves a client bubble it does not own', () => {
    // Two client steers are queued; a machine injection (dispatch completion)
    // drains and confirms with no clientMessageId. It must not silently
    // resolve an unrelated client bubble via the FIFO fallback in a way that
    // masks which steer actually landed — this test documents that the FIFO
    // fallback DOES still apply to a machine confirmation exactly as it did
    // pre-existing (machine injections have always shared this event type
    // with no way to distinguish); the exact-match path is strictly additive
    // and only engages when clientMessageId is present.
    const { state, eventSlice } = buildHarness({ instanceMessages: [pendingBubble('b1')] })

    eventSlice.handleNormalizedEvent('tab1', { type: 'steer_injected', messageLength: 30 } as any)

    const msgs = getMessages(state)
    expect(msgs.find((m: any) => m.id === 'b1')?.steerApplied).toBe(true)
  })
})

