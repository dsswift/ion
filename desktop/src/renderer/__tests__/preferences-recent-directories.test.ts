// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreferencesStore } from '../preferences'

const saveSettings = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { ion: { saveSettings: typeof saveSettings } }).ion = { saveSettings }
  usePreferencesStore.setState({
    recentBaseDirectories: [],
    directoryUsageCounts: {},
  })
})

describe('recent directory capture', () => {
  it('records local projects once per use and moves them to most recent', () => {
    const directory = '/Volumes/projects/alpha'

    usePreferencesStore.getState().addRecentBaseDirectory(directory)
    usePreferencesStore.getState().addRecentBaseDirectory('/Volumes/projects/beta')
    usePreferencesStore.getState().addRecentBaseDirectory(directory)

    expect(usePreferencesStore.getState().recentBaseDirectories).toEqual([
      directory,
      '/Volumes/projects/beta',
    ])
    expect(usePreferencesStore.getState().directoryUsageCounts).toEqual({
      [directory]: 2,
      '/Volumes/projects/beta': 1,
    })
  })

  it.each([
    '/Users/example/.ion/worktrees/project-a3f1',
    '/Users/example/.ion/integration/project-main',
  ])('does not capture ephemeral workspace %s', (directory) => {
    usePreferencesStore.getState().addRecentBaseDirectory(directory)

    expect(usePreferencesStore.getState().recentBaseDirectories).toEqual([])
    expect(usePreferencesStore.getState().directoryUsageCounts).toEqual({})
    expect(saveSettings).not.toHaveBeenCalled()
  })
})
