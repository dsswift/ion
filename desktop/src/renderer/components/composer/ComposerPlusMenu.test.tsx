// @vitest-environment jsdom
/**
 * The `+` menu. Pins: every host is offered "Attach file" (the web platform's
 * own picker), screenshot is offered on a native shell or a page that can
 * capture the screen, each built-in row stages what it gets, extension rows
 * render under a divider, and the keymap's window events reach the same
 * actions as a click.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../hooks/useViewportClamp', () => ({ useViewportClamp: () => undefined }))
vi.mock('../git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
let layer: HTMLElement | null = null
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => layer }))

const shot = { id: 'shot-1', type: 'image' as const, name: 'shot.png', path: '/tmp/shot.png' }
const picked = new File(['hi'], 'a.txt')
const frame = new File(['png'], 'screenshot.png', { type: 'image/png' })
const takeScreenshot = vi.fn(async () => shot)
const stageFiles = vi.fn(async () => undefined)
const stageNativeCapture = vi.fn(async () => undefined)
const pickLocalFiles = vi.fn(async () => [picked])
const captureScreenFrame = vi.fn(async () => frame)
// Hoisted: the host mock is read at import time (platform/mod-key.ts), which
// runs before a plain `let` in this file is initialised.
const env = vi.hoisted(() => ({ caps: ['nativeShell'] as string[], canCapture: false }))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { takeScreenshot: () => takeScreenshot() }, capabilities: () => env.caps },
}))
vi.mock('./attachment-staging', () => ({
  stageFiles: (...args: unknown[]) => stageFiles(...(args as [])),
  stageNativeCapture: (...args: unknown[]) => stageNativeCapture(...(args as [])),
}))
vi.mock('./local-file-sources', () => ({
  pickLocalFiles: () => pickLocalFiles(),
  captureScreenFrame: () => captureScreenFrame(),
  canCaptureScreen: () => env.canCapture,
}))

import { ComposerPlusMenu, type ComposerPlusMenuItem } from './ComposerPlusMenu'
import { COMPOSER_ATTACH_EVENT, COMPOSER_SCREENSHOT_EVENT } from './composer-events'

const flush = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

describe('ComposerPlusMenu', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.clearAllMocks()
    env.caps = ['nativeShell']
    env.canCapture = false
  })

  function mount(extraItems?: ComposerPlusMenuItem[]): void {
    layer = document.createElement('div')
    container = document.createElement('div')
    document.body.append(container, layer)
    root = createRoot(container)
    act(() => root.render(<ComposerPlusMenu extraItems={extraItems} />))
  }

  const button = (): HTMLButtonElement => container.querySelector('[data-testid="composer-plus-button"]') as HTMLButtonElement
  const open = (): void => act(() => button().click())
  const row = (id: string): HTMLButtonElement | null => layer!.querySelector(`[data-testid="composer-plus-item-${id}"]`)

  it('stages the picked files and closes', async () => {
    mount()
    open()
    act(() => row('attach')!.click())
    await flush()
    expect(pickLocalFiles).toHaveBeenCalledTimes(1)
    expect(stageFiles).toHaveBeenCalledWith([picked], 'pick')
    expect(layer!.querySelector('[data-testid="composer-plus-menu"]')).toBeNull()
  })

  it('stages nothing when the picker is cancelled', async () => {
    pickLocalFiles.mockResolvedValueOnce([])
    mount()
    open()
    act(() => row('attach')!.click())
    await flush()
    expect(stageFiles).not.toHaveBeenCalled()
  })

  it('stages the native screenshot through the capture path', async () => {
    mount()
    open()
    act(() => row('screenshot')!.click())
    await flush()
    expect(stageNativeCapture).toHaveBeenCalledWith(shot)
    expect(captureScreenFrame).not.toHaveBeenCalled()
  })

  it('offers a browser host the file picker, and no screenshot when the page cannot capture', async () => {
    env.caps = ['terminal', 'git', 'files']
    mount()
    expect(button().disabled).toBe(false)
    open()
    expect(row('attach')).not.toBeNull()
    expect(row('screenshot')).toBeNull()
  })

  it('captures a browser screenshot through screen sharing when the page can', async () => {
    env.caps = []
    env.canCapture = true
    mount()
    open()
    act(() => row('screenshot')!.click())
    await flush()
    expect(takeScreenshot).not.toHaveBeenCalled()
    expect(stageFiles).toHaveBeenCalledWith([frame], 'capture')
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

  it('runs attach when the keymap rings the attach event, on a browser host too', async () => {
    env.caps = []
    mount()
    act(() => { window.dispatchEvent(new CustomEvent(COMPOSER_ATTACH_EVENT)) })
    await flush()
    expect(pickLocalFiles).toHaveBeenCalledTimes(1)
  })

  it('ignores the screenshot event where no capture is offered', async () => {
    env.caps = []
    mount()
    act(() => { window.dispatchEvent(new CustomEvent(COMPOSER_SCREENSHOT_EVENT)) })
    await flush()
    expect(captureScreenFrame).not.toHaveBeenCalled()
    expect(takeScreenshot).not.toHaveBeenCalled()
  })
})
