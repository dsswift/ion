// @vitest-environment jsdom
/**
 * The lightning button exists only when a Quick Tool applies to the active
 * conversation — from either source.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Tool { id: string; name: string; icon: string; command: string }
const empty = { user: [] as Tool[], project: [] as Tool[], projectTrusted: false, projectToolsHash: 'h1', projectDirectory: '/src/ion' }
let tools = { ...empty }
const runQuickTool = vi.fn(async (_tab: string, _tool: string) => undefined)
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { activeTabId: string }) => unknown) => selector({ activeTabId: 'tab-1' }),
    { getState: () => ({ runQuickTool }) },
  ),
}))
const trustProjectQuickTools = vi.fn(async (_dir: string, _hash: string) => ({ trusted: true }))
vi.mock('../../host/host-instance', () => ({ host: { shell: { trustProjectQuickTools: (d: string, h: string) => trustProjectQuickTools(d, h) } } }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../git/ConfirmDialog', () => ({
  ConfirmDialog: ({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) => (
    <div data-testid="trust-dialog">
      <pre>{message}</pre>
      <button data-testid="trust-confirm" onClick={onConfirm} />
      <button data-testid="trust-cancel" onClick={onCancel} />
    </div>
  ),
}))
vi.mock('./useActiveQuickTools', () => ({ useActiveQuickTools: () => tools }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../QuickToolsTray', () => ({
  // Like the real tray: choosing a tool reports it, then closes the tray.
  QuickToolsTray: ({ onProjectTool, onClose }: { onProjectTool: (tool: Tool) => void; onClose: () => void }) => (
    <button data-testid="quick-tools-tray" onClick={() => { onProjectTool(tools.project[0]); onClose() }} />
  ),
}))

import { ComposerQuickToolsButton } from './ComposerQuickToolsButton'

describe('ComposerQuickToolsButton', () => {
  let container: HTMLDivElement
  let root: Root
  afterEach(() => { act(() => root.unmount()); container.remove(); tools = { ...empty }; vi.clearAllMocks() })

  function mount(): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<ComposerQuickToolsButton />))
  }
  const button = (): HTMLButtonElement | null => container.querySelector('[data-testid="composer-quick-tools-button"]')

  it('renders nothing with no tools', () => {
    mount()
    expect(button()).toBeNull()
  })

  it('renders for a user tool and opens the tray', () => {
    tools = { ...empty, user: [{ id: 'u1', name: 'U', icon: 'Play', command: 'x' }] }
    mount()
    act(() => button()!.click())
    expect(container.querySelector('[data-testid="quick-tools-tray"]')).not.toBeNull()
  })

  it('renders when only the project ships a tool', () => {
    tools = { ...empty, project: [build] }
    mount()
    expect(button()).not.toBeNull()
  })

  const build: Tool = { id: 'build', name: 'Build desktop', icon: 'Hammer', command: 'make desktop' }
  const chooseProjectTool = (): void => {
    act(() => button()!.click())
    act(() => (container.querySelector('[data-testid="quick-tools-tray"]') as HTMLButtonElement).click())
  }

  it('shows every command in full and runs nothing until the operator trusts the list', async () => {
    tools = { ...empty, project: [build] }
    mount()
    chooseProjectTool()
    expect(container.querySelector('[data-testid="trust-dialog"]')?.textContent).toContain('make desktop')
    expect(runQuickTool).not.toHaveBeenCalled()

    await act(async () => { (container.querySelector('[data-testid="trust-confirm"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(trustProjectQuickTools).toHaveBeenCalledWith('/src/ion', 'h1')
    expect(runQuickTool).toHaveBeenCalledWith('tab-1', 'project:build')
  })

  it('runs nothing when the operator declines, or when the Environment refuses the trust', async () => {
    tools = { ...empty, project: [build] }
    mount()
    chooseProjectTool()
    act(() => (container.querySelector('[data-testid="trust-cancel"]') as HTMLButtonElement).click())
    expect(container.querySelector('[data-testid="trust-dialog"]')).toBeNull()

    trustProjectQuickTools.mockResolvedValueOnce({ trusted: false })
    chooseProjectTool()
    await act(async () => { (container.querySelector('[data-testid="trust-confirm"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(runQuickTool).not.toHaveBeenCalled()
  })

  it('runs a trusted project tool straight away', () => {
    tools = { ...empty, project: [build], projectTrusted: true }
    mount()
    chooseProjectTool()
    expect(container.querySelector('[data-testid="trust-dialog"]')).toBeNull()
    expect(runQuickTool).toHaveBeenCalledWith('tab-1', 'project:build')
  })
})
