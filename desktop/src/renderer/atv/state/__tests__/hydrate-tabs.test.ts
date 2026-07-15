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
    expect(inst.permissionMode).toBe('auto') // the ATV status bar follows the owner flip
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
