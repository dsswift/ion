/**
 * The settings registry (`@ion/shared/settings-registry`) is only a gate if
 * it is complete. `packages/shared` cannot see the server's preference types,
 * so the cross-checks live here, where both sides are visible.
 */
import { describe, expect, it } from 'vitest'
import { SETTINGS_REGISTRY, settingScope, isServerWrittenSettingKey, settingKeysInScope } from '@ion/shared/settings-registry'
import { ENVIRONMENT_OWNED_SETTINGS_KEYS, SERVER_OWNED_SETTINGS_KEYS } from '@ion/shared/settings-classification'
import { STUDIO_SETTING_KEYS } from '../persistence/studio-settings-keys'
import { SETTINGS_DEFAULTS } from '../preferences-types'
import { PROJECTABLE_SETTINGS } from '../projectable-settings'

// Compile-time half: a preference added to SETTINGS_DEFAULTS with no registry
// entry fails `tsc`, before any test runs.
const _everyDefaultIsRegistered: Record<keyof typeof SETTINGS_DEFAULTS, unknown> = SETTINGS_REGISTRY
void _everyDefaultIsRegistered

describe('settings registry completeness', () => {
  it('classifies every persisted preference', () => {
    const missing = Object.keys(SETTINGS_DEFAULTS).filter((key) => settingScope(key) === undefined)
    expect(missing).toEqual([])
  })

  it('classifies every projectable setting', () => {
    const missing = PROJECTABLE_SETTINGS.map((s) => s.key).filter((key) => settingScope(key) === undefined)
    expect(missing).toEqual([])
  })

  it('classifies every Studio surface setting', () => {
    const missing = [...STUDIO_SETTING_KEYS].filter((key) => settingScope(key) === undefined)
    expect(missing).toEqual([])
  })

  it('lists no server setting among the Studio surface keys', () => {
    // studio.setSetting writes the caller's overlay, where the server never
    // reads an Environment setting.
    expect([...STUDIO_SETTING_KEYS].filter((key) => settingScope(key) === 'environment')).toEqual([])
  })

  it('agrees with the environment-owned key list', () => {
    for (const key of ENVIRONMENT_OWNED_SETTINGS_KEYS) expect(settingScope(key)).toBe('environment')
  })

  it('marks exactly the server-owned keys as server-written', () => {
    const marked = settingKeysInScope('environment').filter((key) => isServerWrittenSettingKey(key)).sort()
    expect(marked).toEqual([...SERVER_OWNED_SETTINGS_KEYS].sort())
  })
})

/**
 * The structural half of "a client's setting is the client's": the server's
 * preferences facade cannot hand out a Personal preference or a Device
 * setting, because it has no getter for one. A reader added later fails here.
 */
describe('server preferences facade', () => {
  it('exposes Environment and Account settings only', async () => {
    const { usePreferencesStore } = await import('../persistence/preferences')
    const exposed = Object.keys(Object.getOwnPropertyDescriptors(usePreferencesStore.getState()))
      .filter((key) => settingScope(key) !== undefined)
    const clientOwned = exposed.filter((key) => settingScope(key) === 'personal' || settingScope(key) === 'device')
    expect(clientOwned).toEqual([])
    expect(exposed.length).toBeGreaterThan(0)
  })
})
