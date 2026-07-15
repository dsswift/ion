/**
 * Round-trip half of the WI-005 persistence-shape suite: serialize →
 * (externalize/merge) → buildPopulatedInstance. Split from
 * wi-005-persistence-shape.test.ts at the round-trip seam to stay under the
 * file-size cap; the shared helpers are duplicated header (same mocks).
 */
/**
 * WI-005: unified conversation-pane persistence shape (#259)
 *
 * Empirical finding (STEP 1):
 *   The engine conversation file (.llm.jsonl / .tree.jsonl) contains ONLY
 *   'user', 'assistant', and 'tool' rows (via flattenEntries → SessionMessage).
 *   The renderer pane for an extension-hosted tab adds renderer-only rows that
 *   are NOT in the engine file:
 *     - role: 'harness' — extension harness banners, /clear dividers
 *     - role: 'system'  — extension error notices, engine-start failures
 *   These cannot be reloaded from disk; they must be persisted as message content.
 *
 * Implementation branch taken: DATA FACT, not tab type.
 *   serializeConversationPane now branches on instanceHasRendererOnlyRows()
 *   (does the instance contain any harness/system rows?), NOT on opts.hasExtensions
 *   / tabHasExtensions. A plain tab with harness rows persists content; an
 *   extension-hosted tab without harness rows persists count-only.
 *
 * Coverage:
 *   1. Guard: serializeConversationPane does NOT branch on a tab-type flag.
 *      Same input messages → same output regardless of which side it came from.
 *   2. instanceHasRendererOnlyRows: correct classification for all role combos.
 *   3. Round-trip: persist → restore plain tab → identical conversation state.
 *   4. Round-trip: persist → restore extension-hosted tab → identical state.
 *   5. Content arm fires when harness row present (regardless of tab type).
 *   6. Count-only arm fires when no harness/system rows (regardless of tab type).
 *   7. Migration regression: pre-Phase-4 hasEngineExtension boolean restores
 *      correctly via persistedTabHasExtensions fallback. Revert-check: removing
 *      the fallback makes this test red.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock heavy Electron/browser modules BEFORE any import that transitively
// pulls them in. useTabRestoration-engine imports sessionStore and preferences;
// without mocks, the test environment crashes because localStorage and window
// are not available in the vitest node environment.
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map() }), setState: vi.fn() },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({ permissionMode: 'auto', tabRecoveryEnabled: false, expandOnTabSwitch: true }),
  },
}))
vi.mock('../../stores/session-store-persistence', () => ({
  isExtensionErrorMessage: (m: any) => m.role === 'system',
}))

import {
  serializeConversationPane,
  collectExternalInstanceMessages,
} from '../../stores/serialize-conversation-pane'
import { buildPopulatedInstance } from '../../hooks/useTabRestoration-engine'
import type { ConversationPane, ConversationInstance, ConversationRef } from '../../../shared/types-engine'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(role: string, content = 'hello') {
  return { id: `msg-${Math.random()}`, role, content, timestamp: Date.now() } as any
}

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
  } as any
}

function makePane(inst: ConversationInstance & ConversationRef): ConversationPane {
  return { instances: [inst], activeInstanceId: inst.id } as any
}

// ─── 3 & 4. Round-trip: persist → restore ────────────────────────────────────

describe('serializeConversationPane + buildPopulatedInstance round-trip', () => {
  it('plain tab: count-only persist → buildPopulatedInstance → skeleton (empty messages, positive count)', () => {
    const msgs = [makeMsg('user', 'q1'), makeMsg('assistant', 'a1')]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length, conversationIds: ['conv-plain'] })
    const serialized = serializeConversationPane(makePane(inst), { tabIdForLog: 'rt-plain' })

    expect(serialized).toBeDefined()
    const persisted = serialized!.instances[0]

    // Count-only: no messages
    expect(persisted.messages).toBeUndefined()
    expect(persisted.messageCount).toBe(2)

    // Restore via buildPopulatedInstance
    const restored = buildPopulatedInstance(persisted, 'tab-plain', {
      workingDirectory: '/tmp',
      engineProfileId: null,
    } as any)

    // Skeleton: empty messages but positive messageCount
    expect(restored.messages).toHaveLength(0)
    expect(restored.messageCount).toBe(2)
    expect(restored.conversationIds).toEqual(['conv-plain'])
  })

  it('extension-hosted tab with harness rows: externalize → merge → buildPopulatedInstance → full messages', () => {
    const msgs = [
      makeMsg('user', 'start'),
      makeMsg('harness', '── Session started ──'),
      makeMsg('assistant', 'ready'),
    ]
    const inst = makeInstance({
      messages: msgs,
      messageCount: msgs.length,
      conversationIds: ['conv-ext'],
      permissionMode: 'auto',
    })
    const pane = makePane(inst)
    const serialized = serializeConversationPane(pane, { tabIdForLog: 'rt-ext' })

    expect(serialized).toBeDefined()
    const persisted = serialized!.instances[0]

    // v4 content arm: marker on the thin instance, payload via the collector.
    expect(persisted.messages).toBeUndefined()
    expect(persisted.hasExternalContent).toBe(true)
    const content = collectExternalInstanceMessages(pane)!
    expect(content.messages).toHaveLength(3) // user + harness + assistant

    // EAGER path (active tab): the main process merges content back before
    // the renderer sees it. Simulate the merged shape.
    const restored = buildPopulatedInstance({ ...persisted, messages: content.messages }, 'tab-ext', {
      workingDirectory: '/tmp',
      engineProfileId: 'cos',
    } as any)
    expect(restored.messages).toHaveLength(3)
    expect(restored.messageCount).toBe(3)
    expect(restored.conversationIds).toEqual(['conv-ext'])
    expect(restored.externalContentStatus).toBeUndefined()

    // LAZY path (non-active tab): thin instance restores pending; content
    // loads on first activation via loadSkeletonMessages.
    const lazy = buildPopulatedInstance(persisted, 'tab-ext', {
      workingDirectory: '/tmp',
      engineProfileId: 'cos',
    } as any)
    expect(lazy.messages).toHaveLength(0)
    expect(lazy.externalContentStatus).toBe('pending')
    expect(lazy.messageCount).toBe(3)
  })

  it('extension-hosted tab WITHOUT harness rows: count-only persist → skeleton', () => {
    // Extension tab where the harness never injected display rows.
    const msgs = [makeMsg('user'), makeMsg('assistant'), makeMsg('tool')]
    const inst = makeInstance({
      messages: msgs,
      messageCount: msgs.length,
      conversationIds: ['conv-ext-clean'],
    })
    const serialized = serializeConversationPane(makePane(inst), { tabIdForLog: 'rt-ext-clean' })

    expect(serialized).toBeDefined()
    const persisted = serialized!.instances[0]

    // Count-only
    expect(persisted.messages).toBeUndefined()
    expect(persisted.messageCount).toBe(3)

    // Restore
    const restored = buildPopulatedInstance(persisted, 'tab-ext-clean', {
      workingDirectory: '/tmp',
      engineProfileId: 'cos',
    } as any)

    // Skeleton: empty messages, positive messageCount (lazy-load will refill from engine file)
    expect(restored.messages).toHaveLength(0)
    expect(restored.messageCount).toBe(3)
  })

  it('plain tab with harness row: content arm fires and content survives round-trip', () => {
    const msgs = [makeMsg('user'), makeMsg('harness', '── /clear ──'), makeMsg('assistant')]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const pane = makePane(inst)
    const serialized = serializeConversationPane(pane, { tabIdForLog: 'rt-plain-harness' })

    const persisted = serialized!.instances[0]
    expect(persisted.hasExternalContent).toBe(true)
    const content = collectExternalInstanceMessages(pane)!

    // Round-trip via the eager (main-process merged) shape.
    const restored = buildPopulatedInstance({ ...persisted, messages: content.messages }, 'tab-ph', {} as any)
    // 3 rows survive (user + harness + assistant); assistant gets sealed
    expect(restored.messages).toHaveLength(3)
    expect(restored.messages.find((m) => m.role === 'harness')).toBeDefined()
  })

  it('engine-generated image attachments survive the persist → restore round-trip (#224)', () => {
    // Regression: a conversation with a renderer-only row (harness/system) is
    // forced onto the content-persistence arm. Before the fix, the serializer's
    // per-message projection omitted `attachments`, so tool-result images the
    // engine replayed via flattenEntries were stripped on save. On restart the
    // restored instance is non-empty (so the skeleton lazy-load that re-fetches
    // from the engine never fires) and the persisted, image-less copy is
    // authoritative — the inline thumbnails silently vanish.
    //
    // Revert-check: remove the `attachments` spread in serialize-conversation-pane.ts
    // OR the `attachments: m.attachments` line in useTabRestoration-engine.ts and
    // the final assertion goes red (restored tool row has no attachments).
    const toolMsg = makeMsg('tool', '[Image: screenshot]')
    toolMsg.toolName = 'Screenshot'
    toolMsg.toolId = 'toolu_shot'
    toolMsg.attachments = [
      { id: 'img:/conv/images/abc.png', type: 'image', name: 'abc.png', path: '/conv/images/abc.png', mimeType: 'image/png' },
    ]
    const msgs = [
      makeMsg('user', 'take a screenshot'),
      makeMsg('harness', '── Session started ──'), // forces content-persistence arm
      makeMsg('assistant', 'Taking a screenshot.'),
      toolMsg,
    ]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length, conversationIds: ['conv-img'] })

    const imgPane = makePane(inst)
    serializeConversationPane(imgPane, { tabIdForLog: 'rt-img' })
    const content = collectExternalInstanceMessages(imgPane)!

    // Seam 1 (serializer/collector): the persisted tool row carries its attachments.
    const persistedTool = content.messages.find((m) => m.role === 'tool')
    expect(persistedTool).toBeDefined()
    expect(persistedTool!.attachments).toHaveLength(1)
    expect(persistedTool!.attachments![0]).toMatchObject({ type: 'image', path: '/conv/images/abc.png' })

    // Seam 2 (rehydration): buildPopulatedInstance restores them onto the message.
    const restored = buildPopulatedInstance({ id: 'main', label: 'Main', messages: content.messages }, 'tab-img', {
      workingDirectory: '/tmp',
      engineProfileId: 'cos',
    } as any)
    const restoredTool = restored.messages.find((m) => m.role === 'tool')
    expect(restoredTool).toBeDefined()
    expect(restoredTool!.attachments).toHaveLength(1)
    expect(restoredTool!.attachments![0]).toMatchObject({ type: 'image', name: 'abc.png', path: '/conv/images/abc.png' })
  })
})

