// @vitest-environment jsdom
/**
 * useStudioLayout's browser-Studio-client path: layout persistence rides the
 * studio-wire (studio-settings-actions.ts) on every host, so hydration reads
 * the persisted layout and a patch schedules a real persist write.
 *
 * Production incident this pins: a browser Studio reload once reset the left
 * sidebar to closed and its view to Explorer, with the knock-on effect that
 * the Git panel read as "missing" even though the repository was correctly
 * detected the whole time -- because the sidebar was collapsed before the
 * user could see any tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { studioGetSettings, studioSetSetting, capabilities } = vi.hoisted(() => ({
  studioGetSettings: vi.fn(),
  studioSetSetting: vi.fn(() => Promise.resolve(true)),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../../host/host-instance', () => ({
  host: { capabilities, shell: { studioGetSettings, studioSetSetting } },
}))

import { useStudioLayout, type UseStudioLayoutResult } from '../useStudioLayout'

beforeEach(() => {
  vi.useFakeTimers()
  studioGetSettings.mockClear()
  studioSetSetting.mockClear()
  capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
  studioGetSettings.mockResolvedValue({ studioLayout: { leftSidebarVisible: true, leftSidebarView: 'git' } })
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

describe('useStudioLayout on a browser Studio client', () => {
  it('hydrates from studioGetSettings, restoring the sidebar the user left open on Git', async () => {
    const h = renderLayoutHook()
    expect(studioGetSettings).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.result().hydrated).toBe(true)
    expect(h.result().layout.leftSidebarVisible).toBe(true)
    expect(h.result().layout.leftSidebarView).toBe('git')
    h.unmount()
  })

  it('patch schedules a real studioSetSetting persist write', () => {
    const h = renderLayoutHook()
    act(() => {
      h.result().patch({ leftSidebarVisible: false })
    })
    expect(studioSetSetting).not.toHaveBeenCalled() // debounced
    vi.advanceTimersByTime(1000)
    expect(studioSetSetting).toHaveBeenCalledWith('studioLayout', expect.objectContaining({ leftSidebarVisible: false }))
    h.unmount()
  })
})
