// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMainPane } from '../../../stores/conversation-instance'
import { makeLocalTab } from '../../../stores/session-store-helpers'
import { useSessionStore } from '../../../stores/sessionStore'
import {
  consumeStudioActiveTab,
  consumeUserMessageEcho,
  hydrateTabsFromSync,
} from '../secondary-store'

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
