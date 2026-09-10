import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ quit: vi.fn() }))
vi.mock('electron', () => ({ app: { quit: calls.quit } }))
vi.mock('../logger', () => ({ log: vi.fn() }))
vi.mock('../state', () => ({ state: { tray: null } }))

import { state } from '../state'
import { handleWindowAllClosed } from '../window-all-closed'

const originalPlatform = process.platform

describe('handleWindowAllClosed', () => {
  beforeEach(() => {
    calls.quit.mockClear()
    ;(state as any).tray = null
  })

  it('does not quit when a tray icon exists, on any platform', () => {
    ;(state as any).tray = {}
    for (const platform of ['darwin', 'win32', 'linux']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      handleWindowAllClosed()
      expect(calls.quit).not.toHaveBeenCalled()
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('quits when there is no tray, on any platform', () => {
    ;(state as any).tray = null
    for (const platform of ['darwin', 'win32', 'linux']) {
      calls.quit.mockClear()
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      handleWindowAllClosed()
      expect(calls.quit).toHaveBeenCalledTimes(1)
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })
})
