/**
 * Where a conversation the server opens by itself starts. A person whose last
 * tab closed or settled used to get one in the server's $HOME with no profile,
 * whatever default project or enterprise lock the instance carried.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const prefs = {
  projects: {} as Record<string, { isDefault?: boolean; profileOverride?: { kind: string; profileId?: string } }>,
  engineProfiles: [] as Array<{ id: string }>,
  defaultBaseDirectory: '',
}
vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => prefs } }))

let lock: { baseDirectory: string; engineProfileId: string } | null = null
vi.mock('../../new-conversation-lock', () => ({ activeNewConversationLock: () => lock }))

import { newTabDefaults } from '../new-tab-defaults'

const HOME = '/data/home/jdoe'
const ORION = '/data/home/jdoe/orion'

beforeEach(() => {
  prefs.projects = {}
  prefs.engineProfiles = []
  prefs.defaultBaseDirectory = ''
  lock = null
})

describe('newTabDefaults', () => {
  it('opens in the default project with its profile override, not in $HOME', () => {
    prefs.projects = { [ORION]: { isDefault: true, profileOverride: { kind: 'profile', profileId: 'orion' } } }
    prefs.engineProfiles = [{ id: 'orion' }]

    expect(newTabDefaults(HOME)).toEqual({ workingDirectory: ORION, hasChosenDirectory: true, engineProfileId: 'orion' })
  })

  it('opens in the default project with no profile when its override names one that does not exist', () => {
    prefs.projects = { [ORION]: { isDefault: true, profileOverride: { kind: 'profile', profileId: 'gone' } } }

    expect(newTabDefaults(HOME).engineProfileId).toBeNull()
  })

  it('falls back to the default base directory, then to home', () => {
    prefs.defaultBaseDirectory = '/work'
    expect(newTabDefaults(HOME)).toEqual({ workingDirectory: '/work', hasChosenDirectory: true, engineProfileId: null })

    prefs.defaultBaseDirectory = ''
    expect(newTabDefaults(HOME)).toEqual({ workingDirectory: HOME, hasChosenDirectory: false, engineProfileId: null })
  })

  it('lets an enterprise lock decide the directory and the profile over the user default project', () => {
    prefs.projects = { '/other': { isDefault: true, profileOverride: { kind: 'plain' } } }
    lock = { baseDirectory: ORION, engineProfileId: 'orion' }

    expect(newTabDefaults(HOME)).toEqual({ workingDirectory: ORION, hasChosenDirectory: true, engineProfileId: 'orion' })
  })
})
