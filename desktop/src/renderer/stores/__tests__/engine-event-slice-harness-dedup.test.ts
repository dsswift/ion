/**
 * engine-event-slice — `engine_harness_message` dedup convention
 * (See full comment in original file; test behavior unchanged, assertions
 * now read from instance.messages in conversationPanes instead of engineMessages Map.)
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  makeLocalTab: vi.fn(),
  nextMsgId: (() => {
    let n = 0
    return vi.fn(() => `mock-msg-${++n}`)
  })(),
  playNotificationIfHidden: vi.fn(async () => {}),
}))

import { createEngineEventSlice } from '../slices/engine-event-slice'
import type { State } from '../session-store-types'

function makeInstance(id: string) {
  return { id, label: id, messages: [], modelOverride: null, permissionMode: 'auto', permissionDenied: null, conversationIds: [], draftInput: '', agentStates: [], statusFields: null, planFilePath: null }
}

function buildHarness() {
  const state: any = {
    tabs: [{ id: 'tab1', hasEngineExtension: true, lastEventAt: 0 }],
    engineWorkingMessages: new Map(),
    engineNotifications: new Map(),
    engineDialogs: new Map(),
    enginePinnedPrompt: new Map(),
    engineUsage: new Map(),
    engineModelFallbacks: new Map(),
    conversationPanes: new Map([['tab1', { instances: [makeInstance('inst1')], activeInstanceId: 'inst1' }]]),
  }
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, patch)
  }
  const get = () => state as State
  const slice = createEngineEventSlice(set, get) as State
  return { state, slice }
}

function getMessages(state: any, tabId: string, instanceId: string) {
  const pane = state.conversationPanes.get(tabId)
  return pane?.instances.find((i: any) => i.id === instanceId)?.messages ?? []
}

describe('engine_harness_message dedupKey convention', () => {
  it('drops the second emission when dedupKey matches a prior harness message', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_harness_message',
      message: 'Welcome to Ion Meta',
      source: 'ion-meta',
      metadata: { dedupKey: 'ion-meta:welcome' },
    } as any)

    slice.handleEngineEvent(key, {
      type: 'engine_harness_message',
      message: 'Welcome to Ion Meta',
      source: 'ion-meta',
      metadata: { dedupKey: 'ion-meta:welcome' },
    } as any)

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('harness')
    expect(msgs[0].content).toBe('Welcome to Ion Meta')
    expect(msgs[0].dedupKey).toBe('ion-meta:welcome')
  })

  it('pushes both emissions when dedupKey values differ', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_harness_message',
      message: 'first',
      metadata: { dedupKey: 'ext:msg-a' },
    } as any)

    slice.handleEngineEvent(key, {
      type: 'engine_harness_message',
      message: 'second',
      metadata: { dedupKey: 'ext:msg-b' },
    } as any)

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].dedupKey).toBe('ext:msg-a')
    expect(msgs[1].dedupKey).toBe('ext:msg-b')
  })

  it('pushes both emissions when metadata/dedupKey is absent (opt-out)', () => {
    const { state, slice } = buildHarness()
    const key = 'tab1:inst1'

    slice.handleEngineEvent(key, {
      type: 'engine_harness_message',
      message: 'bare 1',
    } as any)

    slice.handleEngineEvent(key, {
      type: 'engine_harness_message',
      message: 'bare 2',
      metadata: { someOtherHint: 'foo' },
    } as any)

    const msgs = getMessages(state, 'tab1', 'inst1')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].dedupKey).toBeUndefined()
    expect(msgs[1].dedupKey).toBeUndefined()
  })
})
