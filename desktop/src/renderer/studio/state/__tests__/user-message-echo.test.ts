// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMainPane } from '../../../stores/conversation-instance'
import { makeLocalTab } from '../../../stores/session-store-helpers'
import { useSessionStore } from '../../../stores/sessionStore'
import {
  consumeStudioActiveTab,
  consumeUserMessageEcho,
  hydrateTabsFromSync,
  initHistoryReplace,
} from '../secondary-store'

describe('Studio fork-history causality', () => {
  it('queues a fork transcript until owner sync creates the new tab pane', () => {
    let historyHandler: ((payload: any) => void) | undefined
    ;(window as unknown as { ion: any }).ion = {
      ...((window as unknown as { ion?: object }).ion ?? {}),
      saveTabs: vi.fn(),
      onStudioHistoryReplace: vi.fn((callback) => {
        historyHandler = callback
        return vi.fn()
      }),
    }
    useSessionStore.setState({
      tabs: [], activeTabId: undefined, conversationPanes: new Map(), tabsReady: false,
    })
    initHistoryReplace()

    historyHandler?.({
      tabId: 'fork-tab', instanceId: 'main', queueUntilTabExists: true,
      messages: [{ id: 'entry-1', role: 'user', content: 'forked history', timestamp: 1 }],
    })
    expect(useSessionStore.getState().conversationPanes.has('fork-tab')).toBe(false)

    hydrateTabsFromSync({
      schemaVersion: 4, activeTabIndex: 0,
      tabs: [{
        id: 'fork-tab', conversationId: 'fork-conversation', title: 'Fork', customTitle: null,
        workingDirectory: '/repo', hasChosenDirectory: true, additionalDirs: [],
        conversationPane: { instances: [{ id: 'main', messageCount: 1 }], activeInstanceId: 'main' },
      }],
    })

    const instance = useSessionStore.getState().conversationPanes.get('fork-tab')!.instances[0]
    expect(instance.messages).toEqual([
      { id: 'entry-1', role: 'user', content: 'forked history', timestamp: 1,
        toolName: undefined, toolId: undefined, toolStatus: undefined, dedupKey: undefined,
        planFilePath: undefined, injectionKind: undefined, attachments: undefined },
    ])
    expect(instance.historyHydrated).toBe(true)
  })
})

describe('Studio user-message echo causality', () => {
  beforeEach(() => {
    ;(window as unknown as { ion: unknown }).ion = {
      ...((window as unknown as { ion?: object }).ion ?? {}),
      saveTabs: vi.fn(),
    }
    useSessionStore.setState({
      tabs: [],
      activeTabId: undefined,
      conversationPanes: new Map(),
      tabsReady: false,
    })
  })

  it('queues active target and echo until owner tab pane exists, then drains once', () => {
    const echo = { id: 'request-1', content: 'queued prompt', timestamp: 123 }

    consumeStudioActiveTab('tab-1')
    consumeUserMessageEcho('tab-1', echo)
    expect(useSessionStore.getState().activeTabId).toBeUndefined()

    hydrateTabsFromSync({
      schemaVersion: 3,
      activeTabIndex: 0,
      tabs: [{
        id: 'tab-1',
        title: 'Conversation',
        customTitle: null,
        workingDirectory: '',
        hasChosenDirectory: false,
        additionalDirs: [],
      }],
    })

    const pane = useSessionStore.getState().conversationPanes.get('tab-1')!
    expect(useSessionStore.getState().activeTabId).toBe('tab-1')
    expect(pane.instances[0].messages).toEqual([
      { id: 'request-1', role: 'user', content: 'queued prompt', timestamp: 123 },
    ])
  })

  it('preserves plan implementation provenance from the owner echo', () => {
    const tab = { ...makeLocalTab(), id: 'tab-1' }
    useSessionStore.setState({
      tabs: [tab],
      conversationPanes: new Map([['tab-1', makeMainPane()]]),
    })

    consumeUserMessageEcho('tab-1', {
      id: 'implementation-1', content: 'Implement the plan.', timestamp: 123, implementationPhase: true,
    })

    expect(useSessionStore.getState().conversationPanes.get('tab-1')!.instances[0].messages[0])
      .toMatchObject({ implementationPhase: true })
  })

  it('uses echo identity to prevent duplicate insertion', () => {
    const tab = { ...makeLocalTab(), id: 'tab-1' }
    useSessionStore.setState({
      tabs: [tab],
      conversationPanes: new Map([['tab-1', makeMainPane()]]),
    })
    const echo = { id: 'request-1', content: 'prompt', timestamp: 123 }

    consumeUserMessageEcho('tab-1', echo)
    consumeUserMessageEcho('tab-1', echo)

    expect(useSessionStore.getState().conversationPanes.get('tab-1')!.instances[0].messages)
      .toHaveLength(1)
  })
})
