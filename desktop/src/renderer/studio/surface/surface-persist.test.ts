/**
 * `scheduleSurfacePersist` debounces one `host.shell.studioSetSetting` write
 * of the serialized surface; the write happens on every host because the
 * settings verbs are bridged over the studio-wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const studioSetSetting = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../../host/host-instance', () => ({
  host: {
    shell: { studioSetSetting },
    capabilities: () => [],
  },
}))

import { scheduleSurfacePersist } from './surface-persist'

const emptyState = () => ({
  pinnedTabs: [],
  notification: null,
  scratchProjects: {},
  conversations: {},
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('surface-persist', () => {
  it('writes the serialized surface through studioSetSetting after the debounce', () => {
    scheduleSurfacePersist(emptyState)
    expect(studioSetSetting).not.toHaveBeenCalled()
    vi.runAllTimers()
    vi.runAllTimers()
    expect(studioSetSetting).toHaveBeenCalledWith('studioSurface', expect.anything())
  })
})
