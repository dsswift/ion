// @vitest-environment jsdom
/** Studio dispatch split stays scoped to one active conversation. */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../../stores/sessionStore'
import { resolveSubjectAgent } from '../../hooks/useDispatchTranscript'
import {
  activeDispatchSplit,
  initDispatchSplitConversationGuard,
} from '../dispatch-split-state'
import type { AgentStateUpdate } from '../../../shared/types'

function agent(name: string, dispatchIds: string[], status = 'running'): AgentStateUpdate {
  return {
    name,
    status,
    metadata: {
      dispatches: dispatchIds.map((id) => ({ id, conversationId: `conv-${id}` })),
    },
  } as unknown as AgentStateUpdate
}

beforeAll(() => {
  initDispatchSplitConversationGuard()
})

beforeEach(() => {
  useSessionStore.setState({ activeTabId: 'tab-a', dispatchSplit: null })
})

describe('dispatch split store actions', () => {
  it('stamps the active conversation onto the popup-shaped subject', () => {
    useSessionStore.getState().openDispatchSplit({ agentName: 'researcher', dispatchId: 'd-1' })

    expect(useSessionStore.getState().dispatchSplit).toEqual({
      agentName: 'researcher',
      dispatchId: 'd-1',
      tabId: 'tab-a',
    })
  })

  it('closes when the user dismisses the split', () => {
    useSessionStore.getState().openDispatchSplit({ agentName: 'researcher', dispatchId: 'd-1' })

    useSessionStore.getState().closeDispatchSplit()

    expect(useSessionStore.getState().dispatchSplit).toBeNull()
  })

  it('closes synchronously when active conversation changes', () => {
    useSessionStore.getState().openDispatchSplit({ agentName: 'researcher', dispatchId: 'd-1' })

    useSessionStore.setState({ activeTabId: 'tab-b' })

    expect(useSessionStore.getState().dispatchSplit).toBeNull()
  })

  it('keeps completed detail open for unrelated updates in owning conversation', () => {
    useSessionStore.getState().openDispatchSplit({ agentName: 'researcher', dispatchId: 'd-1' })

    useSessionStore.setState({ settingsOpen: true })

    expect(useSessionStore.getState().dispatchSplit).toEqual({
      agentName: 'researcher',
      dispatchId: 'd-1',
      tabId: 'tab-a',
    })
  })

  it('opens a fresh subject after switching conversations', () => {
    useSessionStore.getState().openDispatchSplit({ agentName: 'researcher', dispatchId: 'd-1' })
    useSessionStore.setState({ activeTabId: 'tab-b' })

    useSessionStore.getState().openDispatchSplit({ agentName: 'writer', dispatchId: 'd-2' })

    expect(useSessionStore.getState().dispatchSplit).toEqual({
      agentName: 'writer',
      dispatchId: 'd-2',
      tabId: 'tab-b',
    })
  })
})

describe('dispatch split ownership guard', () => {
  it('rejects stale subjects before Studio can render or allocate split layout', () => {
    const stale = { agentName: 'researcher', dispatchId: 'd-1', tabId: 'tab-a' }

    expect(activeDispatchSplit(stale, 'tab-b')).toBeNull()
    expect(activeDispatchSplit(stale, 'tab-a')).toEqual(stale)
  })
})

describe('resolveSubjectAgent', () => {
  const agents = [agent('researcher', ['d-1', 'd-2']), agent('writer', ['d-9'])]

  it('resolves by name and dispatch ownership', () => {
    expect(resolveSubjectAgent(agents, { agentName: 'researcher', dispatchId: 'd-2' })?.name).toBe('researcher')
    expect(resolveSubjectAgent(agents, { agentName: 'researcher', dispatchId: 'd-9' })).toBeNull()
  })

  it("matches the empty dispatch sentinel by name", () => {
    expect(resolveSubjectAgent(agents, { agentName: 'writer', dispatchId: '' })?.name).toBe('writer')
  })

  it('returns null for no subject', () => {
    expect(resolveSubjectAgent(agents, null)).toBeNull()
  })
})
