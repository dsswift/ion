// @vitest-environment jsdom
/**
 * `refetchConversation` calls `host.shell.getConversation` on every host: the
 * verb is wire-served (browser-shell-bridge.ts SHELL_INVOKE), so a browser
 * Studio client reporting only the bridged capabilities must reach it, not
 * skip it. AgentPanel.tsx and AgentDetailBody.tsx duplicate the same
 * getConversation call; this pins the shared hook's copy.
 */
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDispatchTranscript, type DispatchTranscriptApi } from '../useDispatchTranscript'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const getConversation = vi.hoisted(() => vi.fn(async () => ({ messages: [] })))

vi.mock('../../host/host-instance', () => ({
  host: { shell: { getConversation }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: { dispatchActivity: Record<string, unknown> }) => unknown) =>
    selector({ dispatchActivity: {} }),
}))

function renderApi(): { api: DispatchTranscriptApi; root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let api: DispatchTranscriptApi | undefined
  function Harness(): null {
    api = useDispatchTranscript(null, null)
    return null
  }
  act(() => { root.render(React.createElement(Harness)) })
  return { api: api!, root, container }
}

describe('useDispatchTranscript refetchConversation', () => {
  it('calls getConversation on a browser host', async () => {
    const { api, root, container } = renderApi()
    await act(async () => { await api.refetchConversation('conv-1', true) })
    expect(getConversation).toHaveBeenCalledWith('conv-1', 0, 200)
    act(() => root.unmount())
    container.remove()
  })
})
