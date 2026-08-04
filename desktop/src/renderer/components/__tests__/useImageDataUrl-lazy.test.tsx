// @vitest-environment jsdom
/**
 * useImageDataUrl's `enabled` gate — pins the lazy-load optimization the
 * gallery depends on.
 *
 * The defect this guards against: ImageGallery passes `enabled={false}` for
 * every tile that has not yet scrolled into the rail viewport, specifically so
 * a fifty-image turn reads bytes over IPC only for the handful of tiles
 * actually on screen. That gate lives entirely inside this hook
 * (`if (!enabled) return` before the IPC call) — no test previously exercised
 * it directly. The gallery's own tests run under jsdom, which has no
 * IntersectionObserver, so ImageGallery takes its documented eager-load
 * fallback and every tile ends up with `load={true}` regardless — the gate
 * itself was never actually exercised as false.
 *
 * Revert contract: deleting the `if (!enabled) return` line makes
 * "does not call readImageDataUrl while disabled" fail (extra call recorded).
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(),
}))

const readImageDataUrl = vi.fn(async (path: string) => ({ dataUrl: `data:image/png;base64,STUB_${path.split('/').pop()}` }))

beforeEach(() => {
  readImageDataUrl.mockClear()
  ;(globalThis as unknown as { window: { ion: unknown } }).window = globalThis as unknown as { ion: unknown }
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = { readImageDataUrl }
})

import { useImageDataUrl } from '../ImageViewer'

/** Exposes the hook's return value on the DOM so assertions can read it. */
function Probe({ path, initialDataUrl, enabled }: { path: string; initialDataUrl?: string; enabled?: boolean }) {
  const dataUrl = useImageDataUrl(path, initialDataUrl, enabled)
  return <div data-testid="probe">{dataUrl ?? ''}</div>
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  await act(async () => { await Promise.resolve() })
  return {
    text: () => container.querySelector('[data-testid="probe"]')?.textContent ?? '',
    rerender: async (next: React.ReactElement) => {
      await act(async () => { root.render(next) })
      await act(async () => { await Promise.resolve() })
    },
    unmount() { act(() => root.unmount()); document.body.removeChild(container) },
  }
}

describe('useImageDataUrl enabled gate', () => {
  it('does not call readImageDataUrl while disabled', async () => {
    const view = await render(<Probe path="/c/never-seen.png" enabled={false} />)
    expect(readImageDataUrl).not.toHaveBeenCalled()
    expect(view.text()).toBe('')
    view.unmount()
  })

  it('calls readImageDataUrl once enabled becomes true', async () => {
    const view = await render(<Probe path="/c/lazy.png" enabled={false} />)
    expect(readImageDataUrl).not.toHaveBeenCalled()
    await view.rerender(<Probe path="/c/lazy.png" enabled={true} />)
    expect(readImageDataUrl).toHaveBeenCalledWith('/c/lazy.png')
    expect(view.text()).toContain('STUB_lazy.png')
    view.unmount()
  })

  it('resolves synchronously from a warm cache even while disabled', async () => {
    // A path already resolved by an earlier enabled tile (or a seeded
    // initialDataUrl) must still paint immediately — disabled only gates the
    // IPC round-trip, never a cache hit, per the hook's own contract comment.
    const warm = await render(<Probe path="/c/warm.png" enabled={true} />)
    expect(readImageDataUrl).toHaveBeenCalledTimes(1)
    warm.unmount()

    readImageDataUrl.mockClear()
    const cold = await render(<Probe path="/c/warm.png" enabled={false} />)
    expect(readImageDataUrl).not.toHaveBeenCalled()
    expect(cold.text()).toContain('STUB_warm.png')
    cold.unmount()
  })

  it('defaults to enabled when the third argument is omitted (existing callers)', async () => {
    const view = await render(<Probe path="/c/default.png" />)
    expect(readImageDataUrl).toHaveBeenCalledWith('/c/default.png')
    view.unmount()
  })
})
