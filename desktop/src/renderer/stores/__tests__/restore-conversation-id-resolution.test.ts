/**
 * Tests for the extension-hosted restore conversationId resolution — the
 * root-cause fix for "agent starts fresh after restart" data loss.
 *
 * Regression contract
 * ───────────────────
 * Before the fix, restoreSingleInstanceTab resolved only
 * `inst.conversationIds[last] || st.conversationId`. When both were empty it
 * omitted sessionId from engineStart and the engine pre-minted a fresh EMPTY
 * conversation, orphaning the real one. These tests pin:
 *   1. resolveRestoreSessionId walks the full source priority.
 *   2. instanceHasPersistedHistory detects real scrollback.
 *   3. restoreSingleInstanceTab refuses a sessionless minting start when an
 *      instance has persisted history but no resolvable id (the data-loss case),
 *      and DOES start with the resolved id when one is available.
 *
 * Reverting resolveRestoreSessionId to `last || st.conversationId` makes the
 * lastKnownSessionId / conversationIds[0] cases go red. Reverting the refuse
 * guard makes the "no engineStart when history + no id" case go red.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  createConversationTab: vi.fn(),
  setState: vi.fn(),
  conversationPanes: new Map(),
  engineStart: vi.fn(),
  engineSetPlanMode: vi.fn(),
  conversationExists: vi.fn(),
  engineProfiles: [{ id: 'profile-1', extensions: ['/ext/a'] }],
}))

const createConversationTab = h.createConversationTab
const setState = h.setState
const getStateConversationPanes = h.conversationPanes
const engineStart = h.engineStart
const engineSetPlanMode = h.engineSetPlanMode
const conversationExists = h.conversationExists

vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      createConversationTab: h.createConversationTab,
      conversationPanes: h.conversationPanes,
    }),
    setState: h.setState,
  },
}))

;(globalThis as any).window = {
  ion: {
    engineStart: h.engineStart,
    engineSetPlanMode: h.engineSetPlanMode,
    conversationExists: h.conversationExists,
  },
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ engineProfiles: h.engineProfiles }) },
}))

vi.mock('../session-store-persistence', () => ({
  isExtensionErrorMessage: () => false,
}))

import {
  resolveRestoreSessionId,
  instanceHasPersistedHistory,
  restoreConversationTab,
} from '../../hooks/useTabRestoration-engine'
import type { PersistedTab, PersistedConversationInstance } from '../../../shared/types-persistence'

function makeInstance(overrides: Partial<PersistedConversationInstance> = {}): PersistedConversationInstance {
  return {
    id: 'main',
    label: 'main',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    messageCount: 1,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    planFilePath: null,
    ...overrides,
  }
}

function makeTab(overrides: Partial<PersistedTab> = {}, inst?: PersistedConversationInstance): PersistedTab {
  const instance = inst ?? makeInstance()
  return {
    conversationId: null,
    title: 'Engine',
    customTitle: null,
    workingDirectory: '/tmp/p',
    hasChosenDirectory: true,
    additionalDirs: [],
    permissionMode: 'auto',
    engineProfileId: 'profile-1',
    conversationPane: { instances: [instance], activeInstanceId: instance.id },
    ...overrides,
  } as PersistedTab
}

describe('resolveRestoreSessionId — id source priority', () => {
  it('prefers the last instance conversationIds entry', () => {
    const id = resolveRestoreSessionId(
      { conversationIds: ['old-1', 'recent-2'] },
      { conversationId: 'tab-conv', lastKnownSessionId: 'lk' },
    )
    expect(id).toBe('recent-2')
  })

  it('falls back to tab conversationId when instance chain is empty', () => {
    const id = resolveRestoreSessionId(
      { conversationIds: [] },
      { conversationId: 'tab-conv', lastKnownSessionId: 'lk' },
    )
    expect(id).toBe('tab-conv')
  })

  it('falls back to lastKnownSessionId when chain and conversationId are empty', () => {
    const id = resolveRestoreSessionId(
      { conversationIds: undefined },
      { conversationId: null, lastKnownSessionId: 'lk-only' },
    )
    expect(id).toBe('lk-only')
  })

  it('falls back to the OLDEST chain entry as a last resort', () => {
    const id = resolveRestoreSessionId(
      { conversationIds: ['oldest', ''] }, // last is empty-string → skip to first
      { conversationId: null, lastKnownSessionId: undefined },
    )
    // last entry '' is falsy → conversationId null → lastKnownSessionId undefined
    // → first entry 'oldest'
    expect(id).toBe('oldest')
  })

  it("returns '' when no id is available anywhere", () => {
    const id = resolveRestoreSessionId(
      { conversationIds: [] },
      { conversationId: null, lastKnownSessionId: undefined },
    )
    expect(id).toBe('')
  })
})

describe('resolveRestoreSessionId — phantom-id guard (#230/#231)', () => {
  it('skips a trailing phantom and resolves to the most-recent REAL chain id', () => {
    // conversationIds = [real, phantom]; the phantom is the trailing (newest)
    // id but has no backing file. The pre-fix logic returned [last] = phantom,
    // which the engine could not load → empty-conversation cascade. With the
    // existence predicate, the real id wins.
    const exists = (id: string) => id === 'real-with-file'
    const got = resolveRestoreSessionId(
      { conversationIds: ['real-with-file', 'phantom-no-file'] },
      { conversationId: null, lastKnownSessionId: undefined },
      exists,
    )
    expect(got).toBe('real-with-file')
  })

  it('returns empty when EVERY candidate is a phantom (forces the refuse-guard)', () => {
    const exists = () => false
    const got = resolveRestoreSessionId(
      { conversationIds: ['phantom-1', 'phantom-2'] },
      { conversationId: 'phantom-tab', lastKnownSessionId: 'phantom-lk' },
      exists,
    )
    expect(got).toBe('')
  })

  it('falls through to a real tab conversationId when the chain is all phantoms', () => {
    const exists = (id: string) => id === 'real-tab-conv'
    const got = resolveRestoreSessionId(
      { conversationIds: ['phantom-1', 'phantom-2'] },
      { conversationId: 'real-tab-conv', lastKnownSessionId: undefined },
      exists,
    )
    expect(got).toBe('real-tab-conv')
  })

  it('falls through to a real lastKnownSessionId when chain and tab id are phantoms', () => {
    const exists = (id: string) => id === 'real-lk'
    const got = resolveRestoreSessionId(
      { conversationIds: ['phantom-1'] },
      { conversationId: 'phantom-tab', lastKnownSessionId: 'real-lk' },
      exists,
    )
    expect(got).toBe('real-lk')
  })

  it('without a predicate preserves the original unfiltered walk', () => {
    // Back-compat: callers that cannot probe disk get the raw priority order.
    const got = resolveRestoreSessionId(
      { conversationIds: ['old', 'newest'] },
      { conversationId: 'tab', lastKnownSessionId: 'lk' },
    )
    expect(got).toBe('newest')
  })
})

describe('instanceHasPersistedHistory', () => {
  it('is true when messages are present', () => {
    expect(instanceHasPersistedHistory({ messages: [{ role: 'user', content: 'x', timestamp: 1 }], messageCount: 0 })).toBe(true)
  })
  it('is true when messageCount > 0 even with no messages array (skeleton)', () => {
    expect(instanceHasPersistedHistory({ messages: [], messageCount: 7 })).toBe(true)
  })
  it('is false for a truly empty instance', () => {
    expect(instanceHasPersistedHistory({ messages: [], messageCount: 0 })).toBe(false)
  })
})

describe('restoreSingleInstanceTab — sessionless minting refusal', () => {
  beforeEach(() => {
    createConversationTab.mockReset().mockResolvedValue('new-tab-0')
    setState.mockReset()
    engineStart.mockReset().mockResolvedValue({ ok: true })
    engineSetPlanMode.mockReset()
    // Default: every probed conversation id has a backing file (real, not a
    // phantom). Tests exercising the phantom path override this per-id.
    conversationExists.mockReset().mockResolvedValue(true)
    getStateConversationPanes.clear()
  })

  it('REFUSES engineStart when instance has history but no resolvable id', async () => {
    // No conversationIds, no conversationId, no lastKnownSessionId, but real messages.
    const inst = makeInstance({ conversationIds: [], messages: [{ role: 'user', content: 'real history', timestamp: 1 }], messageCount: 1 })
    const tab = makeTab({ conversationId: null, lastKnownSessionId: undefined }, inst)

    await restoreConversationTab(tab, [], 0)

    // The minting start is refused — engineStart must NOT be called.
    expect(engineStart).not.toHaveBeenCalled()
  })

  it('starts with the resolved sessionId when one is available', async () => {
    const inst = makeInstance({ conversationIds: ['conv-real'], messages: [{ role: 'user', content: 'hi', timestamp: 1 }], messageCount: 1 })
    const tab = makeTab({ conversationId: null }, inst)

    await restoreConversationTab(tab, [], 0)

    expect(engineStart).toHaveBeenCalledOnce()
    const [, config] = engineStart.mock.calls[0]
    expect(config.sessionId).toBe('conv-real')
  })

  it('skips a trailing PHANTOM id and starts with the real chain id (end-to-end)', async () => {
    // conversationIds = [real, phantom]. Only the real id has a backing file.
    // The restore must probe existence and resume the REAL id, never the
    // trailing phantom — the exact morning failure, pinned end-to-end.
    conversationExists.mockImplementation(async (id: string) => id === 'conv-real')
    const inst = makeInstance({
      conversationIds: ['conv-real', 'phantom-empty'],
      messages: [{ role: 'user', content: 'real history', timestamp: 1 }],
      messageCount: 1,
    })
    const tab = makeTab({ conversationId: null }, inst)

    await restoreConversationTab(tab, [], 0)

    expect(engineStart).toHaveBeenCalledOnce()
    const [, config] = engineStart.mock.calls[0]
    expect(config.sessionId).toBe('conv-real')
  })

  it('REFUSES the start when every candidate id is a phantom (history would be orphaned)', async () => {
    // Instance has real scrollback but every conversationId is a fileless
    // phantom. Starting with any of them would resume an empty session. The
    // restore must refuse the minting start and let the tab lazy-resolve.
    conversationExists.mockResolvedValue(false)
    const inst = makeInstance({
      conversationIds: ['phantom-1', 'phantom-2'],
      messages: [{ role: 'user', content: 'real history', timestamp: 1 }],
      messageCount: 1,
    })
    const tab = makeTab({ conversationId: 'phantom-tab', lastKnownSessionId: 'phantom-lk' }, inst)

    await restoreConversationTab(tab, [], 0)

    expect(engineStart).not.toHaveBeenCalled()
  })

  it('resolves sessionId from lastKnownSessionId when the chain is empty', async () => {
    const inst = makeInstance({ conversationIds: [], messages: [{ role: 'user', content: 'hi', timestamp: 1 }], messageCount: 1 })
    const tab = makeTab({ conversationId: null, lastKnownSessionId: 'lk-recover' }, inst)

    await restoreConversationTab(tab, [], 0)

    expect(engineStart).toHaveBeenCalledOnce()
    const [, config] = engineStart.mock.calls[0]
    expect(config.sessionId).toBe('lk-recover')
  })

  it('seeds the renderer tab conversationId from the resolved id before start', async () => {
    const inst = makeInstance({ conversationIds: ['conv-real'], messages: [{ role: 'user', content: 'hi', timestamp: 1 }], messageCount: 1 })
    const tab = makeTab({ conversationId: null }, inst)

    await restoreConversationTab(tab, [], 0)

    // At least one setState seeds conversationId from the resolved id. We assert
    // the seeding updater produces conversationId='conv-real' for the matching tab.
    const seedingCall = setState.mock.calls.find(([updater]) => {
      if (typeof updater !== 'function') return false
      const next = updater({ tabs: [{ id: 'new-tab-0', conversationId: null }] })
      return next?.tabs?.[0]?.conversationId === 'conv-real'
    })
    expect(seedingCall).toBeTruthy()
  })
})
