// @vitest-environment jsdom
/**
 * The `+` menu replaces the old floating Attach / Screenshot stack. Pins: the
 * built-in rows stage what the host returns, a browser host (no `nativeShell`)
 * is offered neither, extension rows render under a divider, and the keymap's
 * window events reach the same actions as a click.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const addAttachments = vi.fn()
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (s: { addAttachments: typeof addAttachments }) => unknown) => selector({ addAttachments }),
}))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../hooks/useViewportClamp', () => ({ useViewportClamp: () => undefined }))
vi.mock('../git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
let layer: HTMLElement | null = null
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => layer }))

const shot = { id: 'shot-1', type: 'image' as const, name: 'shot.png', path: '/tmp/shot.png' }
const file = { id: 'file-1', type: 'file' as const, name: 'a.txt', path: '/tmp/a.txt' }
const takeScreenshot = vi.fn(async () => shot)
const attachFiles = vi.fn(async () => [file])
// Hoisted: the host mock is read at import time (platform/mod-key.ts), which
// runs before a plain `let` in this file is initialised.
const capState = vi.hoisted(() => ({ caps: ['nativeShell'] as string[] }))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { takeScreenshot: () => takeScreenshot(), attachFiles: () => attachFiles() }, capabilities: () => capState.caps },
}))

import { ComposerPlusMenu, type ComposerPlusMenuItem } from './ComposerPlusMenu'
import { COMPOSER_ATTACH_EVENT } from './composer-events'

describe('ComposerPlusMenu', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.clearAllMocks()
    capState.caps = ['nativeShell']
  })

  function mount(extraItems?: ComposerPlusMenuItem[]): void {
    layer = document.createElement('div')
    container = document.createElement('div')
    document.body.append(container, layer)
    root = createRoot(container)
    act(() => root.render(<ComposerPlusMenu extraItems={extraItems} />))
  }

  const open = (): void => act(() => (container.querySelector('[data-testid="composer-plus-button"]') as HTMLButtonElement).click())
  const row = (id: string): HTMLButtonElement | null => layer!.querySelector(`[data-testid="composer-plus-item-${id}"]`)

  it('stages the picked file and closes', async () => {
    mount()
    open()
    await act(async () => { row('attach')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(addAttachments).toHaveBeenCalledWith([file])
    expect(layer!.querySelector('[data-testid="composer-plus-menu"]')).toBeNull()
  })

  it('stages the captured screenshot', async () => {
    mount()
    open()
    await act(async () => { row('screenshot')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(addAttachments).toHaveBeenCalledWith([shot])
  })

  it('offers neither built-in row to a host without nativeShell, and disables an empty menu', () => {
    capState.caps = ['terminal', 'git', 'files']
    mount()
    expect((container.querySelector('[data-testid="composer-plus-button"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders extension rows under a divider and runs them', () => {
    const onSelect = vi.fn()
    mount([{ id: 'ext-1', label: 'Briefing', detail: 'cos2', icon: null, onSelect }])
    open()
    expect(layer!.querySelector('[data-testid="composer-plus-divider"]')).not.toBeNull()
    expect(row('ext-1')!.textContent).toContain('cos2')
    act(() => row('ext-1')!.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('runs attach when the keymap rings the attach event', async () => {
    mount()
    await act(async () => { window.dispatchEvent(new CustomEvent(COMPOSER_ATTACH_EVENT)); await Promise.resolve(); await Promise.resolve() })
    expect(attachFiles).toHaveBeenCalledTimes(1)
  })
})
