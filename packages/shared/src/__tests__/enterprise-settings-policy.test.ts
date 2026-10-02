import { describe, it, expect } from 'vitest'
import {
  describeSettingsPolicy,
  managedDefaultSettingValues,
  resolveSettingMutability,
  sealedSettingValues,
  settingsPolicyFingerprint,
} from '../enterprise-settings-policy'
import { deriveEnterpriseThemePolicy } from '../enterprise-theme-policy'
import type { EnterprisePolicy } from '../types-enterprise'

const policy = (server?: unknown, desktop?: unknown): EnterprisePolicy => ({
  customFields: {
    ...(server === undefined ? {} : { 'ion-server': { settingsPolicy: server } }),
    ...(desktop === undefined ? {} : { 'ion-desktop': { settingsPolicy: desktop } }),
  },
})

describe('resolveSettingMutability', () => {
  it('leaves every key user-adjustable with no policy', () => {
    for (const p of [null, undefined, {}, { customFields: {} }]) {
      expect(resolveSettingMutability(p, 'gitOpsMode')).toEqual({ class: 'user-adjustable', hasValue: false, source: 'none' })
    }
  })

  it('resolves each class from the key entry', () => {
    const p = policy({ keys: { gitOpsMode: { class: 'sealed', value: 'worktree' }, commitCommand: { class: 'managed-default', value: 'commit' }, preferredModel: { class: 'user-adjustable' } } })
    expect(resolveSettingMutability(p, 'gitOpsMode')).toEqual({ class: 'sealed', hasValue: true, value: 'worktree', source: 'key' })
    expect(resolveSettingMutability(p, 'commitCommand')).toEqual({ class: 'managed-default', hasValue: true, value: 'commit', source: 'key' })
    expect(resolveSettingMutability(p, 'preferredModel')).toEqual({ class: 'user-adjustable', hasValue: false, source: 'key' })
  })

  it('gives an unlisted registered key the default class, and an explicit entry outranks it', () => {
    const p = policy({ defaultClass: 'sealed', keys: { gitOpsMode: { class: 'user-adjustable' } } })
    expect(resolveSettingMutability(p, 'commitCommand')).toEqual({ class: 'sealed', hasValue: false, source: 'default' })
    expect(resolveSettingMutability(p, 'gitOpsMode').class).toBe('user-adjustable')
  })

  it('keeps the default class off what the app records by itself, off runtime values, and off server-written keys', () => {
    const p = policy({ defaultClass: 'sealed' }, { defaultClass: 'sealed' })
    for (const key of ['recentBaseDirectories', 'studioLayout', 'gitPanelHeight', 'enterprisePolicy', 'pairedDevices']) {
      expect(resolveSettingMutability(p, key).class).toBe('user-adjustable')
    }
    // Naming a recorded key still governs it.
    expect(resolveSettingMutability(policy(undefined, { keys: { studioLayout: { class: 'sealed' } } }), 'studioLayout').class).toBe('sealed')
    // A server-written key cannot be governed at all.
    expect(resolveSettingMutability(policy({ keys: { pairedDevices: { class: 'sealed' } } }), 'pairedDevices').class).toBe('user-adjustable')
  })

  it('reads each key from the namespace that stores it, and from no other', () => {
    const wrongSide = policy({ keys: { selectedTheme: { class: 'sealed' } } }, { keys: { gitOpsMode: { class: 'sealed' } } })
    expect(resolveSettingMutability(wrongSide, 'selectedTheme').class).toBe('user-adjustable')
    expect(resolveSettingMutability(wrongSide, 'gitOpsMode').class).toBe('user-adjustable')
    expect(describeSettingsPolicy(wrongSide).ignoredKeys).toEqual(['gitOpsMode', 'selectedTheme'])
  })

  it('classifies an unregistered key only by name, in the namespace of the side that stores it', () => {
    const p = policy({ defaultClass: 'sealed', keys: { legacyKey: { class: 'sealed' } } })
    expect(resolveSettingMutability(p, 'legacyKey', 'ion-server').class).toBe('sealed')
    expect(resolveSettingMutability(p, 'legacyKey', 'ion-desktop').class).toBe('user-adjustable')
    expect(resolveSettingMutability(p, 'otherKey', 'ion-server').class).toBe('user-adjustable')
  })

  it('fails closed on a malformed class, entry, or default', () => {
    expect(resolveSettingMutability(policy({ keys: { gitOpsMode: { class: 'locked' } } }), 'gitOpsMode')).toEqual({ class: 'sealed', hasValue: false, source: 'key' })
    expect(resolveSettingMutability(policy({ keys: { gitOpsMode: 'sealed' } }), 'gitOpsMode').class).toBe('sealed')
    expect(resolveSettingMutability(policy({ defaultClass: 'closed' }), 'gitOpsMode')).toEqual({ class: 'sealed', hasValue: false, source: 'default' })
  })

  it('resolves the two older policy blocks, and lets a settingsPolicy entry outrank them', () => {
    const locked: EnterprisePolicy = { customFields: { 'ion-desktop': { themePolicy: { themeId: 'acme', locked: true } }, 'ion-server': { agentSettingsEdits: { allowed: false } } } }
    expect(resolveSettingMutability(locked, 'selectedTheme')).toEqual({ class: 'sealed', hasValue: true, value: 'acme', source: 'themePolicy' })
    expect(resolveSettingMutability(locked, 'allowSettingsEdits')).toEqual({ class: 'sealed', hasValue: true, value: false, source: 'agentSettingsEdits' })
    const unlocked: EnterprisePolicy = { customFields: { 'ion-desktop': { themePolicy: { themeId: 'acme' }, settingsPolicy: { defaultClass: 'sealed' } } } }
    expect(resolveSettingMutability(unlocked, 'selectedTheme').class).toBe('managed-default')
    const outranked: EnterprisePolicy = { customFields: { 'ion-desktop': { themePolicy: { themeId: 'acme', locked: true }, settingsPolicy: { keys: { selectedTheme: { class: 'user-adjustable' } } } } } }
    expect(resolveSettingMutability(outranked, 'selectedTheme').class).toBe('user-adjustable')
    expect(deriveEnterpriseThemePolicy(outranked)).toBeNull()
  })
})

describe('deriveEnterpriseThemePolicy', () => {
  it('reads a settingsPolicy entry for selectedTheme as the theme policy', () => {
    expect(deriveEnterpriseThemePolicy(policy(undefined, { keys: { selectedTheme: { class: 'sealed', value: 'acme' } } }))).toEqual({ themeId: 'acme', locked: true })
    expect(deriveEnterpriseThemePolicy(policy(undefined, { keys: { selectedTheme: { class: 'managed-default', value: 'acme' } } }))).toEqual({ themeId: 'acme', locked: false })
    // Sealed with no theme named: nothing to enforce here; the write gate holds the value.
    expect(deriveEnterpriseThemePolicy(policy(undefined, { defaultClass: 'sealed' }))).toBeNull()
  })
})

describe('policy values', () => {
  const p = policy(
    { keys: { gitOpsMode: { class: 'sealed', value: 'zz-sealed-value' }, commitCommand: { class: 'managed-default', value: 'zz-default-value' }, relayUrl: { class: 'sealed' } } },
    { keys: { uiZoom: { class: 'sealed', value: 1.2345 }, soundEnabled: { class: 'managed-default', value: false } } },
  )

  it('lists sealed and managed-default values per namespace', () => {
    expect(sealedSettingValues(p, 'ion-server')).toEqual({ gitOpsMode: 'zz-sealed-value' })
    expect(sealedSettingValues(p, 'ion-desktop')).toEqual({ uiZoom: 1.2345 })
    expect(managedDefaultSettingValues(p, 'ion-server')).toEqual({ commitCommand: 'zz-default-value' })
    expect(managedDefaultSettingValues(p, 'ion-desktop')).toEqual({ soundEnabled: false })
  })

  it('describes the class of every key and carries no value', () => {
    const described = describeSettingsPolicy(p)
    expect(described.keys.gitOpsMode).toEqual({ class: 'sealed', source: 'key', namespace: 'ion-server' })
    expect(described.keys.uiZoom).toEqual({ class: 'sealed', source: 'key', namespace: 'ion-desktop' })
    expect(described.keys.preferredModel).toEqual({ class: 'user-adjustable', source: 'none', namespace: 'ion-server' })
    expect(described.namespaces['ion-server']).toEqual({ version: null, defaultClass: 'user-adjustable' })
    const text = JSON.stringify(described)
    for (const value of ['zz-sealed-value', 'zz-default-value', '1.2345']) expect(text).not.toContain(value)
  })

  it('narrows the description to the namespaces asked for', () => {
    const described = describeSettingsPolicy(p, ['ion-server'])
    expect(described.keys.uiZoom).toBeUndefined()
    expect(described.namespaces['ion-desktop']).toBeNull()
  })

  it('fingerprints the policy inputs regardless of key order', () => {
    const a = policy({ defaultClass: 'sealed', keys: { a: { class: 'sealed', value: 1 } } })
    const b = policy({ keys: { a: { value: 1, class: 'sealed' } }, defaultClass: 'sealed' })
    expect(settingsPolicyFingerprint(a)).toBe(settingsPolicyFingerprint(b))
    expect(settingsPolicyFingerprint(a)).not.toBe(settingsPolicyFingerprint(policy({ defaultClass: 'sealed' })))
  })
})
