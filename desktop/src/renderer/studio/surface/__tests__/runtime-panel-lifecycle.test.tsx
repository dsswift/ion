// @vitest-environment jsdom
/**
 * A routed panel's owner lives outside the conversation whose strip holds its
 * tab. These tests pin the two rules that keep the owner's "open" state and
 * the strip together: leaving a conversation closes its panels through their
 * owners, and a release finds the tab in whichever conversation holds it.
 */
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = vi.hoisted(() => ({
  tabs: [
    { id: 'tab-1', workingDirectory: '/repo' },
    { id: 'tab-2', workingDirectory: '/repo' },
  ],
  activeTabId: 'tab-1',
  conversationPanes: new Map(),
  incOpenFloatingPanelCount: () => undefined,
  decOpenFloatingPanelCount: () => undefined,
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (value: typeof session) => unknown) => selector(session),
    { getState: () => session },
  ),
}))
vi.mock('../../../rendererLogger', () => ({
  rDebug: vi.fn(), rTrace: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(),
}))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ studioSurfaceSwitchMode: 'per-conversation' }) },
}))
vi.mock('../../ports/port-forward-store', () => ({ webApplicationUrlForThisMachine: vi.fn() }))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))

import { FloatingPanel } from '../../../components/FloatingPanel'
import { registerSurfaceFileRouter, surfaceRouter } from '../../../lib/file-open-router'
import { registerStudioFileRouter } from '../studio-file-router'
import { RuntimePanelBody, runtimePanel } from '../runtime-panel-registry'
import { useSurfaceStore } from '../surface-store'

/** The owner: a trigger and the panel it opens, mounted outside the canvas. */
function Owner(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)} />
      {open && (
        <FloatingPanel title="Conflicts" onClose={() => setOpen(false)}>
          <div data-testid="panel-body">conflicted files</div>
        </FloatingPanel>
      )}
    </>
  )
}

/** The canvas: draws the active tab's body, as the Surface panel does. */
function Canvas(): React.JSX.Element | null {
  const tabs = useSurfaceStore((state) => state.tabs)
  const activeTabId = useSurfaceStore((state) => state.activeTabId)
  const active = tabs.find((tab) => tab.id === activeTabId)
  return active?.kind === 'runtime-panel' ? <RuntimePanelBody id={active.id} /> : null
}

function panelTabs(conversationId: string): string[] {
  return (useSurfaceStore.getState().conversations[conversationId]?.tabs ?? [])
    .filter((tab) => tab.kind === 'runtime-panel')
    .map((tab) => tab.id)
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function trigger(): void {
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!.click())
}
function openPanel(close: () => void): string {
  let id = ''
  act(() => { id = surfaceRouter()!.openPanel!('Conflicts', <div />, close) })
  return id
}
function bodyShown(): boolean {
  return container.querySelector('[data-testid="panel-body"]') !== null
}

beforeEach(() => {
  ;(window as unknown as { ion: unknown }).ion = {
    studioSetSetting: vi.fn().mockResolvedValue(true),
    studioGetSettings: vi.fn().mockResolvedValue({}),
  }
  useSurfaceStore.setState({
    tabs: [], activeTabId: null, pinnedTabs: [], notification: null, scratchProjects: {},
    conversations: {}, currentConversationId: 'tab-1', visible: false, hydrated: true,
  })
  registerStudioFileRouter(() => useSurfaceStore.getState().setVisible(true))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<><Owner /><Canvas /></>))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  registerSurfaceFileRouter({
    openTextFile: () => undefined,
    openImage: () => undefined,
    openHtml: () => undefined,
    openGitDiff: () => false,
  })()
})

describe('runtime panel lifecycle', () => {
  it('reopens from its trigger after the operator switches conversations', () => {
    trigger()
    expect(bodyShown()).toBe(true)
    expect(panelTabs('tab-1')).toHaveLength(1)

    act(() => useSurfaceStore.getState().selectConversation('tab-2'))

    // Leaving closed it through its owner, so nothing is left behind.
    expect(bodyShown()).toBe(false)
    expect(panelTabs('tab-1')).toEqual([])

    trigger()

    expect(bodyShown()).toBe(true)
    expect(panelTabs('tab-2')).toHaveLength(1)
    expect(useSurfaceStore.getState().activeTabId).toBe(panelTabs('tab-2')[0])
    expect(useSurfaceStore.getState().visible).toBe(true)
  })

  it('calls the owner close callback once and drops the registry entry on leave', () => {
    const close = vi.fn()
    const id = openPanel(close)

    act(() => useSurfaceStore.getState().selectConversation('tab-2'))

    expect(close).toHaveBeenCalledTimes(1)
    expect(runtimePanel(id)).toBeNull()
  })

  it('keeps a panel open when the same conversation is selected again', () => {
    const close = vi.fn()
    const id = openPanel(close)

    act(() => useSurfaceStore.getState().selectConversation('tab-1'))

    expect(close).not.toHaveBeenCalled()
    expect(panelTabs('tab-1')).toEqual([id])
  })

  it('releases a panel held by a conversation that is not on screen', () => {
    const id = openPanel(vi.fn())
    // Another conversation is on screen while the owner unmounts.
    act(() => useSurfaceStore.setState({ currentConversationId: 'tab-2' }))

    act(() => surfaceRouter()!.closePanel!(id))

    expect(panelTabs('tab-1')).toEqual([])
    expect(runtimePanel(id)).toBeNull()
  })
})
