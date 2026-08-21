// @vitest-environment jsdom
/**
 * useStudioLayout — restore-on-boot, patch/normalize, one debounced write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useStudioLayout, type UseStudioLayoutResult } from '../useStudioLayout'
import { STUDIO_LAYOUT_DEFAULTS } from '../../../../shared/types-studio'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const getSettingsMock = vi.fn()
const setSettingMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  getSettingsMock.mockReset()
  setSettingMock.mockReset()
  setSettingMock.mockResolvedValue(true)
  ;(window as unknown as { ion: unknown }).ion = {
    studioGetSettings: getSettingsMock,
    studioSetSetting: setSettingMock,
  }
})
afterEach(() => {
  vi.useRealTimers()
})

function renderLayoutHook(): { result: () => UseStudioLayoutResult; unmount: () => void } {
  let current: UseStudioLayoutResult | null = null
  function Host(): null {
    current = useStudioLayout()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Host />)
  })
  return {
    result: () => {
      if (!current) throw new Error('not rendered')
      return current
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useStudioLayout', () => {
  it('restores the persisted layout on boot and reports hydrated', async () => {
    getSettingsMock.mockResolvedValue({
      studioLayout: { ...STUDIO_LAYOUT_DEFAULTS, leftSidebarVisible: true, leftSidebarView: 'git' },
    })
    const h = renderLayoutHook()
    expect(h.result().hydrated).toBe(false)
    await flushPromises()
    expect(h.result().hydrated).toBe(true)
    expect(h.result().layout.leftSidebarVisible).toBe(true)
    expect(h.result().layout.leftSidebarView).toBe('git')
    h.unmount()
  })

  it('malformed persisted layout normalizes to complete defaults', async () => {
    getSettingsMock.mockResolvedValue({ studioLayout: { leftSidebarWidth: 'huge', leftSidebarView: 'bogus', junk: 1 } })
    const h = renderLayoutHook()
    await flushPromises()
    expect(h.result().layout).toEqual(STUDIO_LAYOUT_DEFAULTS)
    h.unmount()
  })

  it('settings read failure still hydrates with defaults (shell boots)', async () => {
    getSettingsMock.mockRejectedValue(new Error('ipc down'))
    const h = renderLayoutHook()
    await flushPromises()
    expect(h.result().hydrated).toBe(true)
    expect(h.result().layout).toEqual(STUDIO_LAYOUT_DEFAULTS)
    h.unmount()
  })

  it('patch clamps values and issues ONE debounced write for a burst', async () => {
    getSettingsMock.mockResolvedValue({})
    const h = renderLayoutHook()
    await flushPromises()
    act(() => {
      h.result().patch({ surfaceWidth: 400 })
      h.result().patch({ surfaceWidth: 9999 }) // clamps to max 1400
    })
    expect(h.result().layout.surfaceWidth).toBe(1400)
    expect(setSettingMock).not.toHaveBeenCalled() // still inside the debounce
    await act(async () => {
      vi.advanceTimersByTime(350)
      await Promise.resolve()
    })
    expect(setSettingMock).toHaveBeenCalledTimes(1)
    const [key, value] = setSettingMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(key).toBe('studioLayout')
    expect(value.surfaceWidth).toBe(1400)
    h.unmount()
  })

  it('unmount cancels a pending write', async () => {
    getSettingsMock.mockResolvedValue({})
    const h = renderLayoutHook()
    await flushPromises()
    act(() => {
      h.result().patch({ terminalHeight: 360 })
    })
    h.unmount()
    vi.advanceTimersByTime(1000)
    expect(setSettingMock).not.toHaveBeenCalled()
  })
})
