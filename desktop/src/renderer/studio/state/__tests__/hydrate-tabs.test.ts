// @vitest-environment jsdom
/**
 * Mirror tab hydration: the owner-published PersistedTabState snapshot maps
 * into TabState rows with the OWNER'S tab ids (the cross-window join key),
 * pane shells carry the persisted messageCount for lazy loading, and
 * existing panes survive re-sync while owner-closed tabs' panes are dropped.
 */
import { describe, it, expect } from 'vitest'
import { tabsFromSnapshot, mergePanes } from '../hydrate-tabs'
import { makeMainPane } from '../../../stores/conversation-instance'
import type { PersistedTabState } from '../../../../shared/types'

function snapshot(): PersistedTabState {
  return {
    schemaVersion: 3,
    activeSessionId: 'conv-b',
    activeTabIndex: 1,
    tabs: [
      {
        id: 'tab-a',
        conversationId: 'conv-a',
        title: 'Alpha',
        customTitle: null,
        workingDirectory: '/w/alpha',
        hasChosenDirectory: true,
        additionalDirs: [],
        groupId: 'g1',
        pillColor: '#123456',
        conversationPane: {
          activeInstanceId: 'main',
          instances: [{ id: 'main', messageCount: 7, modelOverride: 'claude-x', permissionMode: 'plan' }],
        },
      },
      {
        id: 'tab-b',
        conversationId: 'conv-b',
        title: 'Beta',
        customTitle: 'My Beta',
        workingDirectory: '/w/beta',
        hasChosenDirectory: true,
        additionalDirs: [],
        engineProfileId: 'ion-dev',
        hasEngineExtension: true,
      },
    ],
  } as unknown as PersistedTabState
}

describe('tabsFromSnapshot', () => {
  it('maps owner ids, metadata, and the active tab', () => {
    const { tabs, activeTabId } = tabsFromSnapshot(snapshot())
    expect(tabs.map((t) => t.id)).toEqual(['tab-a', 'tab-b'])
    expect(activeTabId).toBe('tab-b')
    expect(tabs[0].groupId).toBe('g1')
    expect(tabs[0].pillColor).toBe('#123456')
    expect(tabs[1].customTitle).toBe('My Beta')
    expect(tabs[1].engineProfileId).toBe('ion-dev')
  })

  it('hydrates cold settled history separately from active tabs', () => {
    const s = snapshot()
    s.settledHistory = [{
      id: 'settled-a', conversationId: 'conv-settled', title: 'Settled Alpha',
      customTitle: null, workingDirectory: '/w/settled', hasChosenDirectory: true,
      additionalDirs: [], settledOverride: 'settled', settledAt: 123,
      inputLocked: true, inputLockReason: 'settled',
    }]

    const hydrated = tabsFromSnapshot(s)
    expect(hydrated.tabs.map((tab) => tab.id)).not.toContain('settled-a')
    expect(hydrated.settledHistory).toMatchObject([{ id: 'settled-a', settledOverride: 'settled', inputLocked: true }])
  })

  it('projects queued owner attachments into mirror tabs and clears an emptied queue', () => {
    const s = snapshot()
    const staged = [{
      id: 'attachment-1', type: 'image' as const, name: 'pasted image.png',
      path: '/tmp/pasted-image.png', mimeType: 'image/png',
    }]

    const queued = tabsFromSnapshot(s, undefined, undefined, { 'tab-b': staged })
    expect(queued.tabs.find((tab) => tab.id === 'tab-b')!.attachments).toEqual(staged)

    const cleared = tabsFromSnapshot(s, undefined, queued.tabs, { 'tab-b': [] })
    expect(cleared.tabs.find((tab) => tab.id === 'tab-b')!.attachments).toEqual([])
  })

  it('skips rows without an owner id and clamps a bad active index', () => {
    const s = snapshot()
    ;(s.tabs[0] as { id?: string }).id = undefined
    s.activeTabIndex = 99
    const { tabs, activeTabId } = tabsFromSnapshot(s)
    expect(tabs.map((t) => t.id)).toEqual(['tab-b'])
    expect(activeTabId).toBe('tab-b')
  })
})

describe('mergePanes', () => {
  it('keeps existing panes, shells missing ones with persisted counts, drops closed tabs', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s)
    const liveMessages: never[] = []
    const livePane = makeMainPane({ messages: liveMessages, messageCount: 42 })
    const existing = new Map([
      ['tab-a', livePane],
      ['tab-gone', makeMainPane({})],
    ])
    const merged = mergePanes(existing, s, tabs)
    // Kept: the live pane survives (messages identity intact) with the
    // owner-authoritative metadata refreshed from the snapshot.
    const keptA = merged.get('tab-a')!
    expect(keptA.instances[0].messages).toBe(liveMessages)
    expect(keptA.instances[0].messageCount).toBe(42)
    expect(keptA.instances[0].permissionMode).toBe('plan')
    expect(keptA.instances[0].modelOverride).toBe('claude-x')
    expect(merged.has('tab-gone')).toBe(false) // owner closed it
    const shellB = merged.get('tab-b')
    expect(shellB).toBeDefined()
    expect(shellB!.instances[0].messages).toEqual([])
  })

  it('pane shells carry messageCount + permissionMode from the persisted main instance', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s)
    const merged = mergePanes(new Map(), s, tabs)
    const shellA = merged.get('tab-a')!
    // Explicitly unhydrated: live events may land on the shell before the
    // user opens it, and lazy hydration must still load the full history.
    expect(shellA.instances[0].historyHydrated).toBe(false)
    expect(shellA.instances[0].messageCount).toBe(7)
    expect(shellA.instances[0].modelOverride).toBe('claude-x')
    expect(shellA.instances[0].permissionMode).toBe('plan')
  })
})

describe('owner-authoritative metadata refresh on kept panes', () => {
  it('kept panes take permissionMode/planFilePath/permissionDenied from the snapshot', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s)
    const first = mergePanes(new Map(), s, tabs)
    // tab-a persisted permissionMode 'plan'; simulate the owner approving the
    // plan: the next snapshot omits permissionMode (persisted only when
    // non-'auto') and the denial is gone.
    expect(first.get('tab-a')!.instances[0].permissionMode).toBe('plan')
    const after = structuredClone(s)
    ;(after.tabs[0] as { conversationPane?: { instances: Array<Record<string, unknown>> } }).conversationPane = {
      instances: [{ id: 'main', messageCount: 9 }],
    } as never
    const merged = mergePanes(first, after, tabsFromSnapshot(after).tabs)
    const inst = merged.get('tab-a')!.instances[0]
    expect(inst.permissionMode).toBe('auto') // the Studio window status bar follows the owner flip
    expect(inst.planFilePath).toBeNull()
    expect(inst.permissionDenied).toBeNull()
    // Live mirror state that is NOT owner metadata survives untouched.
    expect(inst.messages).toEqual([])
  })

  it('pane identity is preserved when the owner metadata is unchanged', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s)
    const first = mergePanes(new Map(), s, tabs)
    const again = mergePanes(first, s, tabs)
    expect(again.get('tab-a')).toBe(first.get('tab-a'))
    expect(again.get('tab-b')).toBe(first.get('tab-b'))
  })

  it('seeds thinkingEffort on a new pane shell from the persisted main instance', () => {
    const s = snapshot()
    ;(s.tabs[0] as { conversationPane?: { instances: Array<Record<string, unknown>> } }).conversationPane = {
      instances: [{ id: 'main', messageCount: 7, thinkingEffort: 'high' }],
    } as never
    const { tabs } = tabsFromSnapshot(s)
    const merged = mergePanes(new Map(), s, tabs)
    expect(merged.get('tab-a')!.instances[0].thinkingEffort).toBe('high')
  })

  it('defaults a new pane shell to thinkingEffort "off" when the owner has no override set', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s)
    const merged = mergePanes(new Map(), s, tabs)
    expect(merged.get('tab-a')!.instances[0].thinkingEffort).toBe('off')
  })

  it('converges a kept pane\'s thinkingEffort to the owner\'s later setThinkingEffort change', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s)
    const first = mergePanes(new Map(), s, tabs)
    expect(first.get('tab-a')!.instances[0].thinkingEffort).toBe('off')

    // Owner called setThinkingEffort('medium') on this conversation; the next
    // snapshot carries it. Without the fix, the mirror's picker would never
    // update because the field was never read out of the snapshot at all.
    const after = structuredClone(s)
    ;(after.tabs[0] as { conversationPane?: { instances: Array<Record<string, unknown>> } }).conversationPane = {
      instances: [{ id: 'main', messageCount: 7, thinkingEffort: 'medium' }],
    } as never
    const merged = mergePanes(first, after, tabsFromSnapshot(after).tabs)
    expect(merged.get('tab-a')!.instances[0].thinkingEffort).toBe('medium')
  })

  it('resets a kept pane\'s thinkingEffort to "off" when the owner clears it back to no override', () => {
    const s = snapshot()
    ;(s.tabs[0] as { conversationPane?: { instances: Array<Record<string, unknown>> } }).conversationPane = {
      instances: [{ id: 'main', messageCount: 7, thinkingEffort: 'high' }],
    } as never
    const { tabs } = tabsFromSnapshot(s)
    const first = mergePanes(new Map(), s, tabs)
    expect(first.get('tab-a')!.instances[0].thinkingEffort).toBe('high')

    // The owner persists thinkingEffort only when it is non-'off'
    // (serialize-conversation-pane.ts), so a reset-to-off snapshot simply
    // omits the field — the mirror must explicitly fall back to 'off', not
    // retain the stale 'high' value.
    const after = structuredClone(s)
    ;(after.tabs[0] as { conversationPane?: { instances: Array<Record<string, unknown>> } }).conversationPane = {
      instances: [{ id: 'main', messageCount: 7 }],
    } as never
    const merged = mergePanes(first, after, tabsFromSnapshot(after).tabs)
    expect(merged.get('tab-a')!.instances[0].thinkingEffort).toBe('off')
  })
})

describe('live tab statuses (workspace-indicator parity)', () => {
  it('owner-published liveTabStatus is authoritative; never resets to idle', () => {
    const s = snapshot()
    const { tabs } = tabsFromSnapshot(s, { 'tab-a': 'running', 'tab-b': 'idle' })
    expect(tabs.find((t) => t.id === 'tab-a')!.status).toBe('running')
    expect(tabs.find((t) => t.id === 'tab-b')!.status).toBe('idle')
  })

  it('without published statuses, a re-sync preserves the mirror tab status', () => {
    const s = snapshot()
    const first = tabsFromSnapshot(s, { 'tab-a': 'running' })
    // Later sync arrives without statuses (defensive): the mirror's own
    // event-driven status survives instead of resetting to idle.
    const second = tabsFromSnapshot(s, undefined, first.tabs)
    expect(second.tabs.find((t) => t.id === 'tab-a')!.status).toBe('running')
  })
})
