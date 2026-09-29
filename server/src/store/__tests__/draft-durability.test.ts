/**
 * Draft durability: an unsent prompt survives a restart, and reaches a phone.
 *
 * The three links in that chain, each pinned here because each one was broken
 * or absent before:
 *
 *   1. `setDraftInput` writes the text onto the conversation pane. It is a
 *      FORWARDED action, so a Studio window's composer reaches this store
 *      rather than keeping the text in the window — the classification is
 *      asserted directly, since a silent flip back to MIRROR_LOCAL would
 *      restore the original defect with every other test still green.
 *   2. The pane serializer carries the draft into the tabs file, and the
 *      restore path reads it back onto the instance.
 *   3. The remote projection puts it on the wire for iOS.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map() }), setState: vi.fn() },
}))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: {
    getState: () => ({ permissionMode: 'auto', tabRecoveryEnabled: false }),
  },
}))
vi.mock('../../stores/session-store-persistence', () => ({
  isExtensionErrorMessage: (m: { role: string }) => m.role === 'system',
}))

import { serializeConversationPane } from '../serialize-conversation-pane'
import { buildPopulatedInstance } from '../../hooks/useTabRestoration-engine'
import { FORWARDED_ACTIONS, MIRROR_LOCAL_ACTIONS } from '@ion/shared/studio-wire/actions'
import { projectRendererTab } from '../../remote/snapshot-project'
import type { ConversationPane, ConversationInstance, ConversationRef } from '@ion/shared/types-engine'

function makeInstance(overrides: Partial<ConversationInstance & ConversationRef> = {}): ConversationInstance & ConversationRef {
  return {
    id: 'main',
    label: 'main',
    messages: [],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    contextBreakdown: null,
    ...overrides,
  } as unknown as ConversationInstance & ConversationRef
}

function makePane(inst: ConversationInstance & ConversationRef): ConversationPane {
  return { instances: [inst], activeInstanceId: inst.id } as unknown as ConversationPane
}

const DRAFT = 'a prompt I had not finished writing'

describe('the draft is owner-durable state', () => {
  it('setDraftInput is forwarded to the owning server, not kept window-local', () => {
    // The composer that holds the text is in a window; the store that writes
    // the tabs file is in the server process. A mirror-local write never
    // crosses that line, which is why the serialize/restore pair below had
    // nothing to carry for as long as this action was classified that way.
    expect(FORWARDED_ACTIONS.setDraftInput).toEqual({ minArgs: 2, maxArgs: 2, tabIdAt: 0 })
    expect(MIRROR_LOCAL_ACTIONS.setDraftInput).toBeUndefined()
  })

  it('survives the trip through the tabs file and back onto the instance', () => {
    const serialized = serializeConversationPane(
      makePane(makeInstance({ draftInput: DRAFT, conversationIds: ['conv-1'] })),
      { tabIdForLog: 'tab-draft' },
    )

    // What actually lands in tabs.json.
    const persistedMain = serialized?.instances.find((i) => i.id === 'main')
    expect(persistedMain?.draftInput).toBe(DRAFT)

    // And what the next boot builds from it.
    const restored = buildPopulatedInstance(persistedMain as never, 'tab-draft', {} as never)
    expect(restored.draftInput).toBe(DRAFT)
  })

  it('is omitted from the persisted shape when there is no draft', () => {
    const serialized = serializeConversationPane(
      makePane(makeInstance({ draftInput: '', conversationIds: ['conv-1'] })),
      { tabIdForLog: 'tab-empty' },
    )
    const persistedMain = serialized?.instances.find((i) => i.id === 'main')
    expect(persistedMain).not.toHaveProperty('draftInput')
  })

  it('reaches iOS on the tab projection', () => {
    const projected = projectRendererTab(
      { id: 'tab-draft', draftInput: DRAFT },
      { lastMessage: null, permissionQueue: [] } as never,
    )
    expect(projected.draftInput).toBe(DRAFT)
  })

  it('is absent from the projection rather than sent as an empty string', () => {
    const projected = projectRendererTab(
      { id: 'tab-draft', draftInput: '' },
      { lastMessage: null, permissionQueue: [] } as never,
    )
    expect(projected.draftInput).toBeUndefined()
  })
})
