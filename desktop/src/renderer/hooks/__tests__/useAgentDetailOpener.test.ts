// @vitest-environment jsdom
/**
 * Tests for useAgentDetailOpener — the stable-ref event listener hook that
 * bridges the ATV window's click-to-inspect signals to AgentPanel's toggle.
 *
 * Critical behavioral contract:
 *   1. The `ion:open-agent-detail` listener is registered exactly ONCE on
 *      mount, regardless of how many times the component re-renders.
 *   2. The handler always uses the LATEST `agents` and `toggleAgent` values
 *      even though the listener was registered before those values changed.
 *   3. The listener is removed on unmount.
 *
 * Without the stable-ref pattern (dep array missing from useEffect), the
 * listener re-registers on every render. During streaming — one render per
 * text chunk — that produces runaway listener accumulation and is the
 * confirmed source of React error #185 (maximum update depth exceeded).
 *
 * Hook harness follows the repo convention (createRoot + act, no
 * @testing-library/react) — see useEdgeResize.test.ts for the reference.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useAgentDetailOpener } from '../useAgentDetailOpener'
import type { AgentStateUpdate } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Minimal AgentStateUpdate fixture — only the fields the hook and its helpers read.
function makeAgent(name: string, overrides: Partial<AgentStateUpdate> = {}): AgentStateUpdate {
  return {
    name,
    status: 'done',
    metadata: {},
    dispatches: [],
    ...overrides,
  } as AgentStateUpdate
}

function fireOpenDetail(agentName: string) {
  window.dispatchEvent(new CustomEvent('ion:open-agent-detail', { detail: { agentName } }))
}

// ---------------------------------------------------------------------------
// Minimal hook harness: renders the hook in a React component via createRoot
// and exposes a rerender() to update props without remounting.
// ---------------------------------------------------------------------------

interface HarnessProps {
  agents: AgentStateUpdate[]
  toggle: (name: string, agent: AgentStateUpdate) => void
}

function makeHookHarness(initialProps: HarnessProps) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let setProps: (p: HarnessProps) => void = () => {}

  function Harness() {
    const [props, _setProps] = useState<HarnessProps>(initialProps)
    setProps = _setProps
    useAgentDetailOpener(props.agents, props.toggle)
    return null
  }

  act(() => {
    root.render(React.createElement(Harness))
  })

  return {
    rerender(p: HarnessProps) {
      act(() => { setProps(p) })
    },
    unmount() {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('useAgentDetailOpener', () => {
  it('registers the ion:open-agent-detail listener exactly once on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const toggle = vi.fn()
    const agents = [makeAgent('alpha')]

    const hook = makeHookHarness({ agents, toggle })
    cleanups.push(() => hook.unmount())

    const mountCount = addSpy.mock.calls.filter(([type]) => type === 'ion:open-agent-detail').length
    expect(mountCount).toBe(1)

    // Re-render several times (simulates streaming text chunks arriving).
    hook.rerender({ agents: [...agents], toggle })
    hook.rerender({ agents: [...agents], toggle })
    hook.rerender({ agents: [...agents], toggle })

    // Still exactly one registration — the stable-ref dep array [] is holding.
    const afterRerenderCount = addSpy.mock.calls.filter(([type]) => type === 'ion:open-agent-detail').length
    expect(afterRerenderCount).toBe(1)
  })

  it('handler reads the latest agents after a re-render', () => {
    const toggle = vi.fn()
    const initial = [makeAgent('alpha')]
    const updated = [makeAgent('alpha'), makeAgent('beta')]

    const hook = makeHookHarness({ agents: initial, toggle })
    cleanups.push(() => hook.unmount())

    // Re-render with an expanded agents list — the listener was registered before this.
    hook.rerender({ agents: updated, toggle })

    // Fire the event for 'beta', which was NOT in the initial agents list.
    act(() => { fireOpenDetail('beta') })

    // The handler must have read the updated ref, found 'beta', and called toggle.
    expect(toggle).toHaveBeenCalledOnce()
    expect(toggle).toHaveBeenCalledWith('beta', updated[1])
  })

  it('handler reads the latest toggleAgent after a re-render', () => {
    const toggle1 = vi.fn()
    const toggle2 = vi.fn()
    const agents = [makeAgent('alpha')]

    const hook = makeHookHarness({ agents, toggle: toggle1 })
    cleanups.push(() => hook.unmount())

    // Swap out the toggle callback — the listener was already registered with toggle1.
    hook.rerender({ agents, toggle: toggle2 })

    act(() => { fireOpenDetail('alpha') })

    // Must have called the NEW toggle, not the one captured at registration time.
    expect(toggle2).toHaveBeenCalledOnce()
    expect(toggle1).not.toHaveBeenCalled()
  })

  it('removes the listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const toggle = vi.fn()
    const agents = [makeAgent('alpha')]

    const hook = makeHookHarness({ agents, toggle })

    hook.unmount()

    const removals = removeSpy.mock.calls.filter(([type]) => type === 'ion:open-agent-detail').length
    expect(removals).toBe(1)

    // Firing after unmount must NOT call toggle.
    act(() => { fireOpenDetail('alpha') })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('does not call toggle when agentName is missing from detail', () => {
    const toggle = vi.fn()
    const agents = [makeAgent('alpha')]

    const hook = makeHookHarness({ agents, toggle })
    cleanups.push(() => hook.unmount())

    act(() => {
      window.dispatchEvent(new CustomEvent('ion:open-agent-detail', { detail: {} }))
    })

    expect(toggle).not.toHaveBeenCalled()
  })

  it('does not call toggle when the named agent is not in the list', () => {
    const toggle = vi.fn()
    const agents = [makeAgent('alpha')]

    const hook = makeHookHarness({ agents, toggle })
    cleanups.push(() => hook.unmount())

    act(() => { fireOpenDetail('nonexistent') })

    expect(toggle).not.toHaveBeenCalled()
  })
})
