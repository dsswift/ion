import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The WebContentsView browser body.
 *
 * These pin the behaviours that the `<webview>` implementation could not have:
 * a guest that Playwright can attach to, and geometry that main owns because
 * the body is no longer in the document.
 */
const registerTarget = vi.hoisted(() => vi.fn())
const unregisterTarget = vi.hoisted(() => vi.fn())
const installGuestPolicy = vi.hoisted(() => vi.fn())

interface FakeView {
  webContents: {
    id: number
    destroyed: boolean
    isDestroyed(): boolean
    loadURL: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    handlers: Map<string, () => void>
    debugger: { isAttached(): boolean; attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> }
  }
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
  options: unknown
}


const created: FakeView[] = []

vi.mock('electron', () => ({
  WebContentsView: class {
    webContents: FakeView['webContents']
    setBounds = vi.fn()
    setVisible = vi.fn()
    options: unknown
    constructor(options: unknown) {
      const handlers = new Map<string, () => void>()
      this.options = options
      this.webContents = {
        id: created.length + 1,
        destroyed: false,
            debugger: {
          isAttached: () => true,
          attach: vi.fn(),
          sendCommand: vi.fn(async () => ({})),
        },
        isDestroyed() { return this.destroyed },
        loadURL: vi.fn(async () => undefined),
        close: vi.fn(),
        reload: vi.fn(),
        on: vi.fn((event: string, fn: () => void) => { handlers.set(event, fn) }),
        handlers,
      }
      created.push(this as unknown as FakeView)
    }
  },
}))
vi.mock('./logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
// A macOS hiddenInset window: content starts 28px below the window top, which
// is exactly the offset that pushed the browser body out of its tab.
/** Content sits 28px below the window top; that gap is the bug under test. */
const contentBounds = vi.hoisted(() => ({ x: 100, y: 228, width: 1200, height: 772 }))
const studioWindow = vi.hoisted(() => ({
  isDestroyed: () => false,
  contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  getBounds: () => ({ x: 100, y: 200, width: 1200, height: 800 }),
  getContentBounds: () => ({ x: 100, y: 228, width: 1200, height: 772 }),
}))
vi.mock('./state', () => ({ state: { studioWindow } }))
vi.mock('./studio-playwright/host', () => ({
  registerStudioPlaywrightWebview: registerTarget,
  unregisterStudioPlaywrightWebview: unregisterTarget,
}))
vi.mock('./webview-policy', () => ({
  installGuestPolicy,
  previewPartitionFor: (id: string) => `studio-preview-${id}`,
}))

import {
  reapplyBrowserViewBounds,
  setPopoverRects,
  browserViewContents,
  destroyAllBrowserViews,
  destroyBrowserView,
  ensureBrowserView,
  hideBrowserViewsExcept,
  navigateBrowserView,
  setBrowserViewBounds,
} from './studio-browser-views'

const BOUNDS = { x: 10, y: 20, width: 800, height: 600 }

function make(conversationId = 'conv-1', instanceId = 'inst-1', partition = 'persist:studio-browser') {
  return ensureBrowserView({ conversationId, instanceId, partition, url: 'https://example.test/' })
}

beforeEach(() => {
  destroyAllBrowserViews()
  created.length = 0
  vi.clearAllMocks()
})

describe('guest creation', () => {
  it('registers the guest so browser tools can resolve it', () => {
    const guest = make()
    expect(guest).not.toBeNull()
    // This is the whole reason the body moved out of the DOM: a webview target
    // is invisible to Playwright, a WebContentsView is a real page target.
    expect(registerTarget).toHaveBeenCalledWith('conv-1', 'inst-1', guest)
  })

  it('hardens the guest with the shared policy', () => {
    make('conv-1', 'inst-1', 'studio-preview-abc')
    // A view has no will-attach-webview event, so hardening is explicit.
    expect(installGuestPolicy).toHaveBeenCalledWith(expect.anything(), 'studio-preview-abc')
  })

  it('creates a sandboxed guest with no preload', () => {
    make()
    const prefs = (created[0]!.options as { webPreferences: Record<string, unknown> }).webPreferences
    // A browser tab renders untrusted pages; the floor matches what the
    // webview policy enforced on attach.
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.preload).toBeUndefined()
  })

  it('carries the partition so sessions and the preview shield still apply', () => {
    make('conv-1', 'inst-1', 'studio-isolated-xyz')
    const prefs = (created[0]!.options as { webPreferences: Record<string, unknown> }).webPreferences
    expect(prefs.partition).toBe('studio-isolated-xyz')
  })

  it('reuses the existing view for the same tab', () => {
    const first = make()
    const second = make()
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
  })

  it('parks a new view off-screen until bounds arrive', () => {
    make()
    // Added without bounds a view paints at 0,0 over the whole shell for a
    // frame, which reads as the browser hijacking the window.
    const bounds = created[0]!.setBounds.mock.calls[0]![0] as { x: number }
    expect(bounds.x).toBeLessThan(0)
  })
})

describe('geometry', () => {
  it('positions and shows the view where the renderer measured', () => {
    make()
    expect(setBrowserViewBounds('conv-1', 'inst-1', BOUNDS, true)).toBe(true)
    expect(created[0]!.setVisible).toHaveBeenCalledWith(true)
    // Applied verbatim: the renderer's rect is already in the coordinate
    // space a contentView child uses.
    expect(created[0]!.setBounds).toHaveBeenLastCalledWith(BOUNDS)
  })

  it('moves a hidden view away instead of only hiding it', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', BOUNDS, false)
    expect(created[0]!.setVisible).toHaveBeenCalledWith(false)
    // Visibility alone has been observed to leave a ghost frame during a
    // window resize, so the bounds move too.
    const last = created[0]!.setBounds.mock.calls.at(-1)![0] as { x: number }
    expect(last.x).toBeLessThan(0)
  })

  it('hides every view except the active one', () => {
    make('conv-1', 'inst-1')
    make('conv-1', 'inst-2')
    setBrowserViewBounds('conv-1', 'inst-1', BOUNDS, true)
    setBrowserViewBounds('conv-1', 'inst-2', BOUNDS, true)

    hideBrowserViewsExcept('conv-1', 'inst-2')
    // A view paints above page content, so a background tab left visible would
    // cover the foreground one.
    expect(created[0]!.setVisible).toHaveBeenLastCalledWith(false)
    expect(created[1]!.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('reports false for a tab with no view', () => {
    expect(setBrowserViewBounds('conv-1', 'missing', BOUNDS, true)).toBe(false)
  })
})

describe('lifecycle', () => {
  it('navigates an existing view', () => {
    const guest = make()
    expect(navigateBrowserView('conv-1', 'inst-1', 'https://next.test/')).toBe(true)
    expect(guest!.loadURL).toHaveBeenCalledWith('https://next.test/')
  })

  it('destroys the view and releases its automation target', () => {
    make()
    expect(destroyBrowserView('conv-1', 'inst-1')).toBe(true)
    expect(browserViewContents('conv-1', 'inst-1')).toBeNull()
    expect(created[0]!.webContents.close).toHaveBeenCalled()
    // Without this the tools would keep resolving a dead guest.
    expect(unregisterTarget).toHaveBeenCalledWith('conv-1', 'inst-1')
    expect(browserViewContents('conv-1', 'inst-1')).toBeNull()
  })

  it('releases every view when Studio closes', () => {
    make('conv-1', 'inst-1')
    make('conv-2', 'inst-2')
    destroyAllBrowserViews()
    // Views are children of the Studio window; leaving them behind would keep
    // guests running with their sessions open.
    expect(created[0]!.webContents.close).toHaveBeenCalled()
    expect(created[1]!.webContents.close).toHaveBeenCalled()
    expect(browserViewContents('conv-1', 'inst-1')).toBeNull()
  })

  it('drops its registry entry when the guest dies on its own', () => {
    make()
    created[0]!.webContents.destroyed = true
    created[0]!.webContents.handlers.get('destroyed')?.()
    expect(unregisterTarget).toHaveBeenCalledWith('conv-1', 'inst-1')
    expect(browserViewContents('conv-1', 'inst-1')).toBeNull()
  })
})

describe('coordinate space', () => {
  it('applies the renderer rect without conversion', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', { x: 10, y: 40, width: 500, height: 400 }, true)
    // A contentView child is positioned relative to the content view, and
    // getBoundingClientRect already reports real pixels in that space. Two
    // earlier "corrections" (title-bar offset, UI-zoom division) each moved the
    // view away from its hole; the measurement needs no adjustment.
    expect(created[0]!.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 40, width: 500, height: 400 })
  })

  it('clamps a view that would extend past the content area', () => {
    make()
    // Taller than the content area: during a resize the renderer's measurement
    // can lag the window by a frame.
    setBrowserViewBounds('conv-1', 'inst-1', { x: 0, y: 700, width: 1200, height: 400 }, true)
    const applied = created[0]!.setBounds.mock.calls.at(-1)![0] as { y: number; height: number }
    // A view is not clipped by the page, so an unclamped rect paints over
    // whatever sits below the panel.
    expect(applied.y + applied.height).toBeLessThanOrEqual(contentBounds.height)
  })

  it('re-applies the same rect after a window resize', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', { x: 10, y: 40, width: 500, height: 400 }, true)
    created[0]!.setBounds.mockClear()
    reapplyBrowserViewBounds(studioWindow as never)
    expect(created[0]!.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 40, width: 500, height: 400 })
  })
})

describe('popovers over a browser view', () => {
  const FULL = { x: 0, y: 100, width: 800, height: 600 }

  beforeEach(() => setPopoverRects([]))

  function lastBounds(): { x: number; y: number; width: number; height: number } {
    return created[0]!.setBounds.mock.calls.at(-1)![0] as { x: number; y: number; width: number; height: number }
  }

  it('hides the view while a popover covers it', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    setPopoverRects([{ x: 0, y: 100, width: 300, height: 200 }])
    // A view is composited above the renderer, so a DOM menu can never be
    // layered over it and the view cannot render behind it.
    expect(created[0]!.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('never moves the view, so the page cannot reflow', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    setPopoverRects([{ x: 0, y: 100, width: 300, height: 200 }])
    // Shrinking the view resizes its viewport; the page reflowed and its
    // content jumped, which read as the menu shoving the page down.
    expect(lastBounds()).toMatchObject(FULL)
  })

  it('leaves the view alone when a popover does not overlap it', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    created[0]!.setVisible.mockClear()
    // An inbox row tooltip, nowhere near the browser. Hiding for any popover
    // anywhere is what made the canvas flash on every inbox hover.
    setPopoverRects([{ x: 0, y: 0, width: 200, height: 40 }])
    expect(created[0]!.setVisible).not.toHaveBeenCalledWith(false)
  })

  it('restores the view when the popover closes', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    setPopoverRects([{ x: 0, y: 100, width: 300, height: 200 }])
    setPopoverRects([])
    expect(created[0]!.setVisible).toHaveBeenLastCalledWith(true)
    // Same bounds it had before, so it reappears showing exactly what it
    // showed.
    expect(lastBounds()).toMatchObject(FULL)
  })

  it('keeps the view hidden across a geometry push', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    setPopoverRects([{ x: 0, y: 100, width: 300, height: 200 }])
    // The renderer pushes bounds continuously; without the overlap check here
    // any resize or splitter drag would paint the view back over the menu.
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    expect(created[0]!.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('checks every popover, not just the first', () => {
    make()
    setBrowserViewBounds('conv-1', 'inst-1', FULL, true)
    // A tooltip far away plus a menu over the browser: the second must still
    // hide it.
    setPopoverRects([
      { x: 0, y: 0, width: 100, height: 20 },
      { x: 0, y: 100, width: 300, height: 200 },
    ])
    expect(created[0]!.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('leaves a background tab hidden', () => {
    make('conv-1', 'inst-1')
    setBrowserViewBounds('conv-1', 'inst-1', FULL, false)
    created[0]!.setVisible.mockClear()
    setPopoverRects([{ x: 0, y: 100, width: 300, height: 200 }])
    setPopoverRects([])
    // It was not visible before the popover and must not become visible after.
    expect(created[0]!.setVisible).not.toHaveBeenCalledWith(true)
  })
})
