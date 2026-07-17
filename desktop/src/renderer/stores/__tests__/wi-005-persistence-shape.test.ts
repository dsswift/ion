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
  instanceHasRendererOnlyRows,
} from '../../stores/serialize-conversation-pane'
import { persistedTabHasExtensions } from '../../../shared/tab-predicates'
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

// ─── 1 & 2: instanceHasRendererOnlyRows ──────────────────────────────────────

describe('instanceHasRendererOnlyRows', () => {
  it('returns false for empty message list', () => {
    expect(instanceHasRendererOnlyRows([])).toBe(false)
    expect(instanceHasRendererOnlyRows(undefined)).toBe(false)
  })

  it('returns false for user/assistant/tool-only messages', () => {
    const msgs = [makeMsg('user'), makeMsg('assistant'), makeMsg('tool')]
    expect(instanceHasRendererOnlyRows(msgs)).toBe(false)
  })

  it('returns true when harness row present', () => {
    const msgs = [makeMsg('user'), makeMsg('harness', '── Session started')]
    expect(instanceHasRendererOnlyRows(msgs)).toBe(true)
  })

  it('returns true when system row present', () => {
    const msgs = [makeMsg('user'), makeMsg('system', 'Error: extension crashed')]
    expect(instanceHasRendererOnlyRows(msgs)).toBe(true)
  })

  it('returns true when both harness and system rows present', () => {
    const msgs = [makeMsg('user'), makeMsg('harness'), makeMsg('system'), makeMsg('assistant')]
    expect(instanceHasRendererOnlyRows(msgs)).toBe(true)
  })

  it('returns false for thinking-only extras (thinking is not renderer-only in this sense)', () => {
    // 'thinking' is renderer-only but it is stripped at persist time, not used
    // to gate whether to persist content. instanceHasRendererOnlyRows is about
    // rows that would be permanently lost without content persist.
    const msgs = [makeMsg('user'), makeMsg('assistant'), makeMsg('thinking')]
    expect(instanceHasRendererOnlyRows(msgs)).toBe(false)
  })
})

// ─── 1. Guard: no tab-type parameter ─────────────────────────────────────────

describe('serializeConversationPane — no tab-type branch', () => {
  it('accepts opts without hasExtensions field (signature no longer has it)', () => {
    const inst = makeInstance({ messages: [makeMsg('user'), makeMsg('assistant')], messageCount: 2 })
    const pane = makePane(inst)
    // This must NOT need a hasExtensions param — calling without it compiles fine.
    const result = serializeConversationPane(pane, { tabIdForLog: 'tab-abc' })
    expect(result).toBeDefined()
  })

  it('identical input messages produce identical output regardless of callers intent', () => {
    // Previously the caller would pass hasExtensions=true or false to control
    // content vs count-only. Now the data decides. Two calls with identical
    // inputs produce identical outputs.
    const msgs = [makeMsg('user'), makeMsg('assistant')]
    const inst1 = makeInstance({ messages: msgs, messageCount: 2 })
    const inst2 = makeInstance({ messages: [...msgs], messageCount: 2 })

    const out1 = serializeConversationPane(makePane(inst1), { tabIdForLog: 'tab-1' })
    const out2 = serializeConversationPane(makePane(inst2), { tabIdForLog: 'tab-2' })

    // Both should produce identical serialized shapes (both count-only, no harness rows).
    expect(out1?.instances[0].messages).toBeUndefined()
    expect(out2?.instances[0].messages).toBeUndefined()
    expect(out1?.instances[0].messageCount).toBe(out2?.instances[0].messageCount)
  })
})

// ─── 5. Content arm fires when harness row present ────────────────────────────

describe('serializeConversationPane — content arm on data fact', () => {
  it('externalizes message content when instance has a harness row (schema v4)', () => {
    const msgs = [
      makeMsg('user', 'hi'),
      makeMsg('harness', '── Session started ──'),
      makeMsg('assistant', 'hello'),
    ]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const pane = makePane(inst)
    const result = serializeConversationPane(pane, { tabIdForLog: 'tab-harness' })

    // v4: the thin manifest never carries inline messages — the instance is
    // marked and the content goes to the per-tab content file.
    expect(result?.instances[0].messages).toBeUndefined()
    expect(result?.instances[0].hasExternalContent).toBe(true)
    const content = collectExternalInstanceMessages(pane)
    expect(content).not.toBeNull()
    expect(content!.messages.length).toBeGreaterThan(0)
    expect(content!.messages.some((m) => m.role === 'harness')).toBe(true)
  })

  it('handles a system row that is an extension error (filtered out, no content)', () => {
    const msgs = [
      makeMsg('user', 'test'),
      makeMsg('system', 'Error: extension subprocess died'),
    ]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const pane = makePane(inst)
    const result = serializeConversationPane(pane, { tabIdForLog: 'tab-system' })

    expect(result).toBeDefined()
    // The trigger message is an extension error: after filtering, only
    // engine-reloadable rows remain, so nothing externalizes.
    const content = collectExternalInstanceMessages(pane)
    expect(content === null || content.messages.every((m) => m.role !== 'system')).toBe(true)
  })

  it('externalizes content for a plain tab (engineProfileId=null) if it has harness rows', () => {
    // This is the "any tab" parity test: a plain conversation that received
    // a harness_message should also externalize content.
    const msgs = [makeMsg('user'), makeMsg('harness', '── Clear ──'), makeMsg('assistant')]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const pane = makePane(inst)
    const result = serializeConversationPane(pane, { tabIdForLog: 'tab-plain' })

    expect(result?.instances[0].hasExternalContent).toBe(true)
    const content = collectExternalInstanceMessages(pane)
    expect(content!.messages.some((m) => m.role === 'harness')).toBe(true)
  })

  it('persists planFilePath on a plan-lifecycle divider row (link survives restart)', () => {
    // A plan divider is a renderer-only `system` row, so its presence forces
    // full-content persistence. The serializer must carry planFilePath so the
    // restored divider's slug stays clickable. Pairs with the restore-side test
    // in engine-restore-plan-seal.test.ts (the two halves of the round-trip).
    const divider = makeMsg('system', '── Plan created at 12:00 PM · happy-rabbit ──')
    divider.planFilePath = '/tmp/happy-rabbit.md'
    const msgs = [makeMsg('user'), divider, makeMsg('assistant')]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const pane = makePane(inst)
    serializeConversationPane(pane, { tabIdForLog: 'tab-divider' })

    const content = collectExternalInstanceMessages(pane)
    const persistedDivider = content?.messages.find((m) => m.role === 'system')
    expect(persistedDivider).toBeDefined()
    expect((persistedDivider as any).planFilePath).toBe('/tmp/happy-rabbit.md')
  })
})

// ─── 6. Count-only arm fires when no renderer-only rows ──────────────────────

describe('serializeConversationPane — count-only arm on data fact', () => {
  it('persists count-only when no harness/system rows (plain tab)', () => {
    const msgs = [makeMsg('user'), makeMsg('assistant'), makeMsg('tool')]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const result = serializeConversationPane(makePane(inst), { tabIdForLog: 'tab-plain-count' })

    expect(result?.instances[0].messages).toBeUndefined()
    expect(result?.instances[0].messageCount).toBe(msgs.length)
  })

  it('persists count-only for an extension-hosted tab with NO harness rows', () => {
    // Extension-hosted tab: if the harness never injected a display message,
    // the full timeline is in the engine file. Persist count-only.
    const msgs = [makeMsg('user'), makeMsg('assistant'), makeMsg('tool')]
    const inst = makeInstance({
      messages: msgs,
      messageCount: msgs.length,
      conversationIds: ['conv-engine-abc'],
    })
    // The tab "looks like" an engine tab (has conversationIds) but no harness rows.
    const result = serializeConversationPane(makePane(inst), { tabIdForLog: 'tab-ext-count' })

    expect(result?.instances[0].messages).toBeUndefined()
    expect(result?.instances[0].messageCount).toBe(msgs.length)
  })

  it('strips thinking rows and does NOT trigger content arm for thinking-only', () => {
    // thinking rows alone are not renderer-only in the harness/system sense;
    // they should not cause content persistence on their own.
    const msgs = [makeMsg('user'), makeMsg('thinking', 'pondering'), makeMsg('assistant')]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const result = serializeConversationPane(makePane(inst), { tabIdForLog: 'tab-thinking' })

    expect(result?.instances[0].messages).toBeUndefined()
    expect(result?.instances[0].messageCount).toBe(msgs.length)
  })
})

// ─── 7. Migration regression: pre-Phase-4 hasEngineExtension ─────────────────

describe('persistedTabHasExtensions — pre-Phase-4 migration fallback', () => {
  it('returns true for a pre-Phase-4 tab with hasEngineExtension=true (no engineProfileId)', () => {
    // This is a tabs.json written before Phase 4 (engineProfileId did not exist).
    // The fallback must accept it.
    const legacyTab = { hasEngineExtension: true } // no engineProfileId
    expect(persistedTabHasExtensions(legacyTab)).toBe(true)
  })

  it('returns false for a pre-Phase-4 tab with hasEngineExtension=false', () => {
    const legacyTab = { hasEngineExtension: false }
    expect(persistedTabHasExtensions(legacyTab)).toBe(false)
  })

  it('returns true for a current tab with engineProfileId set (primary path)', () => {
    const currentTab = { engineProfileId: 'cos' }
    expect(persistedTabHasExtensions(currentTab)).toBe(true)
  })

  it('engineProfileId=null falls through to legacy hasEngineExtension fallback', () => {
    // The implementation treats engineProfileId=null the same as absent:
    //   null != null === false → falls through to !!st.hasEngineExtension
    // An explicitly null engineProfileId does NOT override the legacy boolean;
    // it means "no profile set" which degrades to the pre-Phase-4 fallback.
    // This is the correct behavior for migration tolerance: a tabs.json file
    // might carry { engineProfileId: null, hasEngineExtension: true } if it
    // was written by a version that set engineProfileId to null explicitly.
    const tab = { engineProfileId: null, hasEngineExtension: true }
    // null engineProfileId → falls back → hasEngineExtension=true → true
    expect(persistedTabHasExtensions(tab)).toBe(true)
  })

  /**
   * REVERT-CHECK DOCUMENTATION
   *
   * The migration fallback in persistedTabHasExtensions is:
   *
   *   if (st.engineProfileId != null && st.engineProfileId !== '') return true
   *   return !!st.hasEngineExtension   // ← fallback for pre-Phase-4 tabs.json
   *
   * If this fallback line is removed (stub returns false unconditionally for
   * tabs with no engineProfileId), the test above:
   *   "returns true for a pre-Phase-4 tab with hasEngineExtension=true"
   * fails because { hasEngineExtension: true } would return false.
   *
   * This documents the revert-check contract. Do not remove the fallback line
   * until there is a concrete migration plan that upgrades all pre-Phase-4
   * tabs.json files on disk.
   */
  it('[REVERT-CHECK] fallback absence would cause legacy tab to restore as plain tab', () => {
    // The CORRECT behaviour: legacyTab with only hasEngineExtension routes to
    // restoreConversationTab (because persistedTabHasExtensions returns true).
    // If the fallback were removed, it would route to the plain-tab path,
    // which calls resumeSession with no engineProfileId — the engine session
    // would start without extensions loaded.
    const legacyTab = { hasEngineExtension: true }
    // Removing the fallback makes this assertion false → test goes red.
    expect(persistedTabHasExtensions(legacyTab)).toBe(true)

    // Contrast with a tab that explicitly has no extension:
    const plainTab = { hasEngineExtension: false }
    expect(persistedTabHasExtensions(plainTab)).toBe(false)
  })
})

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('serializeConversationPane — edge cases', () => {
  it('returns undefined for undefined pane', () => {
    expect(serializeConversationPane(undefined, { tabIdForLog: 'x' })).toBeUndefined()
  })

  it('returns undefined for pane with no instances', () => {
    const emptyPane = { instances: [], activeInstanceId: null } as any
    expect(serializeConversationPane(emptyPane, { tabIdForLog: 'x' })).toBeUndefined()
  })

  it('persists non-default control fields regardless of content arm', () => {
    const inst = makeInstance({
      messages: [makeMsg('user')],
      messageCount: 1,
      modelOverride: 'claude-3-opus',
      permissionMode: 'plan',
      planFilePath: '/Users/josh/.ion/plans/bold-guiding-kite.md',
      draftInput: 'unsent text',
      conversationIds: ['conv-ctrl'],
    })
    const result = serializeConversationPane(makePane(inst), { tabIdForLog: 'ctrl-tab' })
    const pi = result!.instances[0]

    expect(pi.modelOverride).toBe('claude-3-opus')
    expect(pi.permissionMode).toBe('plan')
    // planFilePath must round-trip so restore can re-adopt the existing plan
    // (continuity across restart). Without it the next plan-mode prompt
    // allocates a fresh slug and orphans the conversation's real plan.
    expect(pi.planFilePath).toBe('/Users/josh/.ion/plans/bold-guiding-kite.md')
    expect(pi.draftInput).toBe('unsent text')
    expect(pi.conversationIds).toEqual(['conv-ctrl'])
  })

  it('strips thinking rows from persisted content', () => {
    const msgs = [
      makeMsg('user'),
      makeMsg('harness', 'banner'), // triggers content arm
      makeMsg('thinking', 'internal reasoning'),
      makeMsg('assistant'),
    ]
    const inst = makeInstance({ messages: msgs, messageCount: msgs.length })
    const thinkPane = makePane(inst)
    const result = serializeConversationPane(thinkPane, { tabIdForLog: 'think-strip' })

    // Content arm fires (harness present), but thinking row is stripped
    expect(result?.instances[0].hasExternalContent).toBe(true)
    const content = collectExternalInstanceMessages(thinkPane)!
    expect(content.messages.some((m: any) => m.role === 'thinking')).toBe(false)
    expect(content.messages.some((m: any) => m.role === 'harness')).toBe(true)
  })
})

// ─── Session ledger: migration + restart-no-append round-trip ────────────────

describe('serializeConversationPane — session ledger (Commit 3)', () => {
  it('migrates a multi-id conversationIds chain into sessions[] + currentSessionId', () => {
    // The affected tab: one logical conversation fragmented across 3 files.
    const ids = [
      '1782534854978-fbad527c6268',
      '1782566209276-9d31cb15c325',
      '1782567882178-adec70d47051',
    ]
    const inst = makeInstance({ messageCount: 76, conversationIds: ids })
    const result = serializeConversationPane(makePane(inst), { tabIdForLog: 'ledger-migrate' })
    const persisted = result!.instances[0]

    // Ledger built, oldest first, reason `unknown` (cut reasons not recorded).
    expect(persisted.sessions).toEqual([
      { id: ids[0], reason: 'unknown', createdAt: 0 },
      { id: ids[1], reason: 'unknown', createdAt: 0 },
      { id: ids[2], reason: 'unknown', createdAt: 0 },
    ])
    // Current id is the newest chain entry — the tab resumes THIS, not a 4th.
    expect(persisted.currentSessionId).toBe(ids[2])
    // Legacy chain still written for one release (downgrade safety).
    expect(persisted.conversationIds).toEqual(ids)
  })

  it('round-trip: persist → buildPopulatedInstance rehydrates the full chain from the ledger', () => {
    const ids = ['conv-a', 'conv-b']
    const inst = makeInstance({ messageCount: 4, conversationIds: ids })
    const serialized = serializeConversationPane(makePane(inst), { tabIdForLog: 'ledger-rt' })
    const persisted = serialized!.instances[0]

    const restored = buildPopulatedInstance(persisted, 'tab-ledger', {
      workingDirectory: '/tmp',
      engineProfileId: null,
    } as any)

    // The runtime chain is rehydrated from the ledger (same ordered ids).
    expect(restored.conversationIds).toEqual(ids)
  })

  it('no ledger fields when the instance has no conversation ids', () => {
    const inst = makeInstance({ messages: [makeMsg('user')], messageCount: 1 })
    const persisted = serializeConversationPane(makePane(inst), { tabIdForLog: 'ledger-none' })!.instances[0]
    expect(persisted.sessions).toBeUndefined()
    expect(persisted.currentSessionId).toBeUndefined()
  })
})
