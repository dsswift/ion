// @vitest-environment jsdom
/**
 * Settings edits the server that is picked, not always the local one.
 *
 * The bug this pins: the dialog read and wrote the app-wide preference store,
 * which is the LOCAL server's. Another server's auto-settle window, or your
 * default model there, could not be seen or changed from here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeWire } from '../../../host/__tests__/fake-wire'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const REMOTE = 'env-remote'
let originalIon: unknown
const saves: Array<{ environmentId: string; patch: Record<string, unknown> }> = []
const deviceWrites: Record<string, unknown>[] = []

// The fake wire dispatches a verb without saying which environment the frame
// was addressed to, so the test notes it as each frame goes out. The verb runs
// synchronously inside that send, before anything awaits.
let addressedTo = 'local'
/** What the remote server's `settings.load` answers. */
let remoteSettings: Record<string, unknown> = { inboxAutoSettleDays: 9, preferredModel: 'acme-gateway/claude-sonnet-5', projectSettingsVersion: 1 }
let target0: () => { projects: Record<string, unknown> } = () => ({ projects: {} })

async function boot(scopes: string[], loaded?: () => boolean) {
  vi.resetModules()
  const wire = installFakeWire({
    loadSettings: () => Promise.resolve(addressedTo === REMOTE
      ? remoteSettings
      : { inboxAutoSettleDays: 0, preferredModel: 'claude-sonnet-5', projectSettingsVersion: 1 }),
    saveSettings: (patch: Record<string, unknown>) => { saves.push({ environmentId: addressedTo, patch }); return Promise.resolve() },
    hostSetDeviceSetting: (key: string, value: unknown) => { deviceWrites.push({ [key]: value }); return Promise.resolve() },
  }) as unknown as { hostSendFrame(environmentId: string, frame: StudioFrame): void }
  const send = wire.hostSendFrame.bind(wire)
  wire.hostSendFrame = (environmentId, frame) => { addressedTo = environmentId; send(environmentId, frame) }
  ;(window as unknown as { ion: unknown }).ion = wire
  const target = await import('../settings-target')
  const { usePreferencesStore } = await import('../../../preferences')
  const { useEnvironmentSettingsStore } = await import('../../../studio/state/environment-settings-store')
  useEnvironmentSettingsStore.getState().hydrate(REMOTE, { inboxAutoSettleDays: 9 }, scopes as never)
  await new Promise((r) => setTimeout(r, 0))
  target.setSettingsTarget(REMOTE)
  // The picked server's settings load over the wire; wait for them to land.
  target0 = () => target.useSettingsPreferences.getState() as never
  await vi.waitFor(() => expect(loaded ? loaded() : target.useSettingsPreferences.getState().inboxAutoSettleDays === 9).toBe(true))
  return { target, usePreferencesStore }
}

beforeEach(() => { remoteSettings = { inboxAutoSettleDays: 9, preferredModel: 'acme-gateway/claude-sonnet-5', projectSettingsVersion: 1 }; originalIon = (window as unknown as { ion?: unknown }).ion; saves.length = 0; deviceWrites.length = 0 })
afterEach(() => { (window as unknown as { ion?: unknown }).ion = originalIon })

describe('settings target', () => {
  it("shows the picked server's values, and leaves the app-wide store on the local server's", async () => {
    const { target, usePreferencesStore } = await boot(['admin'])
    expect(target.useSettingsPreferences.getState().inboxAutoSettleDays).toBe(9)
    expect(target.useSettingsPreferences.getState().preferredModel).toBe('acme-gateway/claude-sonnet-5')
    expect(usePreferencesStore.getState().inboxAutoSettleDays).toBe(0)
    expect(usePreferencesStore.getState().preferredModel).toBe('claude-sonnet-5')
  })

  it('saves a server setting to the picked server', async () => {
    const { target, usePreferencesStore } = await boot(['admin'])
    saves.length = 0
    target.useSettingsPreferences.getState().setPreferredModel('acme-gateway/claude-opus-5')
    expect(saves).toEqual([{ environmentId: REMOTE, patch: { preferredModel: 'acme-gateway/claude-opus-5' } }])
    expect(usePreferencesStore.getState().preferredModel).toBe('claude-sonnet-5')
  })

  it('puts a server-wide change back, and says why, when this device lacks admin there', async () => {
    const { target } = await boot(['conversations:operate'])
    saves.length = 0
    target.useSettingsPreferences.getState().setTabRecoveryEnabled(false)
    expect(target.useSettingsPreferences.getState().tabRecoveryEnabled).toBe(true)
    // Yours on that server still saves.
    target.useSettingsPreferences.getState().setPreferredModel('acme-gateway/claude-opus-5')
    expect(target.useSettingsPreferences.getState().preferredModel).toBe('acme-gateway/claude-opus-5')
  })

  it("keeps this client's own settings one truth, whichever server is picked", async () => {
    const { target, usePreferencesStore } = await boot(['admin'])
    saves.length = 0
    target.useSettingsPreferences.getState().setSoundEnabled(false)
    expect(usePreferencesStore.getState().soundEnabled).toBe(false)
    expect(deviceWrites).toContainEqual({ soundEnabled: false })
    expect(saves, 'a Device setting reaches no server').toEqual([])
  })

  it("keeps this device's enterprise locks in force while another server is picked", async () => {
    // The bug this pins: the picked server's store started with no policy, so
    // a locked theme read as unlocked, the picker enabled, and the change
    // reached the app-wide store around the setter that guards it.
    const { target, usePreferencesStore } = await boot(['admin'])
    const locked = { customFields: { 'ion-desktop': { themePolicy: { themeId: 'ion-dark', locked: true } } } }
    usePreferencesStore.getState().setEnterprisePolicy(locked as never)
    expect(target.useSettingsPreferences.getState().enterprisePolicy).toEqual(locked)
    const before = usePreferencesStore.getState().selectedTheme
    target.useSettingsPreferences.getState().setSelectedTheme('ion-light')
    expect(target.useSettingsPreferences.getState().selectedTheme).toBe(before)
    expect(usePreferencesStore.getState().selectedTheme).toBe(before)
  })

  it("writes another server's load-time clean-up back to THAT server, never to the local one", async () => {
    // The bug this pins, as it happened: Settings opened on a conversation from
    // another server. That server's settings needed the one-time project
    // registry migration, which the loader writes back AFTER its await. The
    // write went to the local server and replaced this machine's whole project
    // list with the other server's.
    remoteSettings = { projects: { '/remote/only/project': { addedManually: true, lastUsedAt: 0 } }, defaultBaseDirectory: '/remote/only/project' }
    const { target } = await boot(['admin'], () => Object.keys(target0().projects).length === 1)
    await vi.waitFor(() => expect(saves.some((s) => 'projects' in s.patch)).toBe(true))
    const projectSaves = saves.filter((s) => 'projects' in s.patch)
    expect(projectSaves.map((s) => s.environmentId)).toEqual(projectSaves.map(() => REMOTE))
    expect(target.useSettingsPreferences.getState().projects).toHaveProperty('/remote/only/project')
  })

  it('is the app-wide store itself for the local server', async () => {
    const { target, usePreferencesStore } = await boot(['admin'])
    target.setSettingsTarget('local')
    expect(target.useSettingsPreferences.getState()).toBe(usePreferencesStore.getState())
  })
})
