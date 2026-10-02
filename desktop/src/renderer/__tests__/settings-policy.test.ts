// @vitest-environment jsdom
/**
 * The enterprise settings policy in the renderer: a sealed setting is not
 * changed in memory or on disk, a sealed value is shown without replacing
 * what the person saved, and a managed default is supplied once per value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeWire } from '../host/__tests__/fake-wire'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

let originalIon: unknown
let deviceWrites: Record<string, unknown>[]
let serverSaves: Record<string, unknown>[]

const device = (settingsPolicy: unknown): EnterprisePolicy => ({ customFields: { 'ion-desktop': { settingsPolicy } } })

async function load() {
  vi.resetModules()
  const { usePreferencesStore } = await import('../preferences')
  const policy = await import('../settings-policy')
  const { applyDeviceSettingsPolicy } = await import('../settings-policy-apply')
  const { policyStore } = await import('../studio/connection/policy-store')
  deviceWrites.length = 0
  serverSaves.length = 0
  return { store: usePreferencesStore, policy, applyDeviceSettingsPolicy, policyStore }
}

beforeEach(() => {
  deviceWrites = []
  serverSaves = []
  originalIon = (window as unknown as { ion?: unknown }).ion
  ;(window as unknown as { ion: unknown }).ion = installFakeWire({
    loadSettings: () => Promise.resolve({}),
    saveSettings: (s: Record<string, unknown>) => { serverSaves.push(s); return Promise.resolve() },
    hostSetDeviceSetting: (key: string, value: unknown) => { deviceWrites.push({ [key]: value }); return Promise.resolve({ ok: true }) },
  })
})
afterEach(() => {
  ;(window as unknown as { ion?: unknown }).ion = originalIon
})

describe('the write gate', () => {
  it('leaves a sealed Device setting unchanged and raises the refusal', async () => {
    const { store, policy } = await load()
    policy.holdDevicePolicy(device({ keys: { soundEnabled: { class: 'sealed' } } }))
    const before = store.getState().soundEnabled
    store.getState().setSoundEnabled(!before)
    expect(store.getState().soundEnabled).toBe(before)
    expect(deviceWrites).toEqual([])
    expect(policy.settingMutability('soundEnabled').class).toBe('sealed')
    // An unsealed setting still saves.
    store.getState().setTerminalFontSize(17)
    expect(deviceWrites).toContainEqual({ terminalFontSize: 17 })
  })

  it('seals a server setting by the policy of the server it is saved to', async () => {
    const { store, policy, policyStore } = await load()
    const sealCommit = { customFields: { 'ion-server': { settingsPolicy: { keys: { commitCommand: { class: 'sealed' } } } } } }
    // Another server's seal is that server's: it does not reach the local one.
    policyStore.set('env-other', sealCommit)
    expect(policy.settingMutability('commitCommand', 'env-other').class).toBe('sealed')
    store.getState().setCommitCommand('mine')
    expect(store.getState().commitCommand).toBe('mine')
    policy.holdDevicePolicy(sealCommit)
    serverSaves.length = 0
    store.getState().setCommitCommand('nope')
    expect(store.getState().commitCommand).toBe('mine')
    expect(serverSaves).toEqual([])
  })

  it('refuses a theme change when the theme is sealed with no policy theme', async () => {
    const { store, policy } = await load()
    const sealed = device({ keys: { selectedTheme: { class: 'sealed' } } })
    store.getState().setEnterprisePolicy(sealed)
    policy.holdDevicePolicy(sealed)
    const before = store.getState().selectedTheme
    store.getState().setSelectedTheme(before === 'ion-light' ? 'ion-dark' : 'ion-light')
    expect(store.getState().selectedTheme).toBe(before)
  })
})

describe('applyDeviceSettingsPolicy', () => {
  it('shows a sealed value without saving it over the person\'s own', async () => {
    const { store, applyDeviceSettingsPolicy } = await load()
    applyDeviceSettingsPolicy(store, device({ keys: { terminalFontSize: { class: 'sealed', value: 11 } } }))
    expect(store.getState().terminalFontSize).toBe(11)
    expect(deviceWrites).toEqual([])
  })

  it('does not apply a sealed value of the wrong shape', async () => {
    const { store, applyDeviceSettingsPolicy } = await load()
    const before = store.getState().terminalFontSize
    applyDeviceSettingsPolicy(store, device({ keys: { terminalFontSize: { class: 'sealed', value: 'large' } } }))
    expect(store.getState().terminalFontSize).toBe(before)
  })
})
