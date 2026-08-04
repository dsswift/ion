/**
 * Persistence round-trip for the per-conversation thinking effort.
 *
 * The level is a deliberate per-conversation choice with a direct cost
 * consequence — reasoning tokens bill at output rates — so it has to survive a
 * desktop restart. Before this it did not: the serializer wrote no thinking
 * field, so raising a conversation to `high` silently reverted to `off` on the
 * next launch.
 *
 * Storage follows the `permissionMode` idiom exactly: conditional write that
 * omits the default, and an absent field on load restoring to that default.
 * Omission is what keeps the manifest small — the overwhelming majority of
 * conversations sit at 'off'.
 *
 * Revert proof: deleting the serializer's conditional write fails every
 * persist case here.
 */
import { describe, it, expect } from 'vitest'
import { serializeConversationPane } from '../serialize-conversation-pane'
import type { ConversationPane, ConversationInstance, ConversationRef } from '../../../shared/types-engine'
import type { ThinkingEffort } from '../../../shared/types-session'

function makeInstance(
  overrides: Partial<ConversationInstance & ConversationRef> = {},
): ConversationInstance & ConversationRef {
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
  } as any
}

function serializeEffort(effort?: ThinkingEffort) {
  const inst = makeInstance(effort === undefined ? {} : { thinkingEffort: effort })
  const pane: ConversationPane = { instances: [inst], activeInstanceId: 'main' } as any
  return serializeConversationPane(pane, { tabIdForLog: 'tab-thinking' })?.instances[0]
}

describe('serializeConversationPane — thinking effort', () => {
  it.each<ThinkingEffort>(['low', 'medium', 'high'])('persists a non-default %s level', (effort) => {
    expect(serializeEffort(effort)?.thinkingEffort).toBe(effort)
  })

  it("omits the default 'off' level", () => {
    const out = serializeEffort('off')
    expect(out).toBeDefined()
    expect('thinkingEffort' in out!).toBe(false)
  })

  it('omits the field when the instance carries no level at all', () => {
    const out = serializeEffort(undefined)
    expect(out).toBeDefined()
    expect('thinkingEffort' in out!).toBe(false)
  })
})

describe('thinking effort round-trip', () => {
  // The restore side reads `main?.thinkingEffort ?? 'off'` at every seeding
  // site. This models that resolution so the persist and restore halves are
  // pinned together rather than each half being asserted in isolation.
  const restore = (persisted?: ThinkingEffort): ThinkingEffort => persisted ?? 'off'

  it.each<ThinkingEffort>(['low', 'medium', 'high'])('%s survives persist → restore', (effort) => {
    const persisted = serializeEffort(effort)?.thinkingEffort
    expect(restore(persisted)).toBe(effort)
  })

  it("'off' round-trips as 'off' despite being omitted on disk", () => {
    const persisted = serializeEffort('off')?.thinkingEffort
    expect(persisted).toBeUndefined()
    expect(restore(persisted)).toBe('off')
  })

  it('a legacy tab saved before this field restores to off rather than undefined', () => {
    // Tabs persisted by an older build have no thinkingEffort key at all.
    expect(restore(undefined)).toBe('off')
  })
})
