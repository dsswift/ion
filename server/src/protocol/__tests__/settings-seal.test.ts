/**
 * Enterprise policy outranks the scope gate on a settings save. An admin can
 * flip "Allow settings edits by the agent"; the organization's seal says no.
 * A hidden settings group is hidden, not just out of sight: its keys are
 * refused for the connection they are hidden from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  readSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  persistAndBroadcastSettings: vi.fn(),
  writeSettingsForSubject: vi.fn(),
  readSettingsForSubject: vi.fn<() => Record<string, unknown>>(() => ({})),
}))
vi.mock('../../persistence/settings-store', () => ({ readSettings: deps.readSettings, SETTINGS_DEFAULTS: {} }))
vi.mock('../../settings-broadcast', () => ({ persistAndBroadcastSettings: deps.persistAndBroadcastSettings, broadcastDesktopSettingsSnapshot: vi.fn() }))
vi.mock('../../persistence/user-settings-store', () => ({ writeSettingsForSubject: deps.writeSettingsForSubject, readSettingsForSubject: deps.readSettingsForSubject }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
const planBash = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(() => []) }))
vi.mock('../../plan-bash-allowlist-store', () => ({ writePlanBashAllowlist: planBash.write, readPlanBashAllowlist: planBash.read }))
vi.mock('../../engine/provider-api', () => ({}))
vi.mock('../../engine/provider-subscription-api', () => ({}))
vi.mock('../hello', () => ({ connectionOnHost: () => true }))

import { SETTINGS_ACTIONS } from '../settings-actions'
import { PROVIDER_ACTIONS } from '../provider-actions'
import { settingsSealRefusal } from '../settings-seal'
import { STUDIO_SETTINGS_ACTIONS } from '../studio-settings-actions'
import { registerEnterprisePolicySource } from '../../enterprise-policy-source'
import { applyProjectableSetting } from '../../remote/handlers/desktop-settings'
import { projectableSchema } from '../../projectable-settings'
import type { Connection } from '../connection'

const localAdmin = { id: 'l', transport: 'local', scopes: ['conversations:read', 'admin'], principal: { subject: 'local:operator' } } as unknown as Connection
const tcpAdmin = { id: 'a', transport: 'tcp', scopes: ['conversations:read', 'admin'], principal: { subject: 'local:operator' } } as unknown as Connection

const SEALED_OFF = { customFields: { 'ion-server': { agentSettingsEdits: { allowed: false } } } }
const HIDE_GIT = { customFields: { 'ion-desktop': { hiddenSettingsGroups: ['git'] } } }

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockClear()
  planBash.write.mockClear()
  deps.readSettings.mockReturnValue({ allowSettingsEdits: false })
  deps.readSettingsForSubject.mockReturnValue({})
  registerEnterprisePolicySource(() => null)
})

describe('settingsSealRefusal', () => {
  it('refuses a sealed key for every connection, admin included', () => {
    expect(settingsSealRefusal(tcpAdmin, SEALED_OFF, ['allowSettingsEdits'])?.code).toBe('settings_sealed')
    expect(settingsSealRefusal(tcpAdmin, null, ['allowSettingsEdits'])).toBeNull()
  })

  it('refuses any key the settings policy seals, naming the key and its class', () => {
    const sealGit = { customFields: { 'ion-server': { settingsPolicy: { keys: { gitOpsMode: { class: 'sealed' } } } } } }
    const refusal = settingsSealRefusal(tcpAdmin, sealGit, ['gitOpsMode', 'commitCommand'])
    expect(refusal).toMatchObject({ code: 'settings_sealed', keys: ['gitOpsMode'], class: 'sealed' })
    expect(refusal?.message).toContain('gitOpsMode')
    expect(settingsSealRefusal(tcpAdmin, sealGit, ['commitCommand'])).toBeNull()
  })

  it('seals an unlisted key under a sealed default, and leaves one the policy opens', () => {
    const failClosed = { customFields: { 'ion-server': { settingsPolicy: { defaultClass: 'sealed', keys: { commitCommand: { class: 'user-adjustable' }, preferredModel: { class: 'managed-default', value: 'm' } } } } } }
    expect(settingsSealRefusal(tcpAdmin, failClosed, ['relayUrl'])?.keys).toEqual(['relayUrl'])
    expect(settingsSealRefusal(tcpAdmin, failClosed, ['commitCommand', 'preferredModel'])).toBeNull()
    // The app's own bookkeeping is not a setting the default reaches.
    expect(settingsSealRefusal(tcpAdmin, failClosed, ['recentBaseDirectories'])).toBeNull()
  })

  it('applies device policy to the local connection only', () => {
    const sealStudioTheme = { customFields: { 'ion-desktop': { settingsPolicy: { keys: { studioTheme: { class: 'sealed' } } } } } }
    expect(settingsSealRefusal(localAdmin, sealStudioTheme, ['studioTheme'])?.code).toBe('settings_sealed')
    expect(settingsSealRefusal(tcpAdmin, sealStudioTheme, ['studioTheme'])).toBeNull()
  })

  it("refuses a hidden group's key on the local connection only", () => {
    expect(settingsSealRefusal(localAdmin, HIDE_GIT, ['gitOpsMode'])?.code).toBe('settings_hidden')
    expect(settingsSealRefusal(tcpAdmin, HIDE_GIT, ['gitOpsMode'])).toBeNull()
    // A key on another page is not refused; a key with no page cannot be hidden.
    expect(settingsSealRefusal(localAdmin, HIDE_GIT, ['projects'])).toBeNull()
    expect(settingsSealRefusal(localAdmin, { customFields: { 'ion-desktop': { hiddenSettingsGroups: ['tabs'] } } }, ['gitPanelHeight'])).toBeNull()
  })

  it('reaches every saved key, not only the ones the phone can edit', () => {
    const hideRemoteAndEnvironments = { customFields: { 'ion-desktop': { hiddenSettingsGroups: ['remote', 'environments'] } } }
    expect(settingsSealRefusal(localAdmin, hideRemoteAndEnvironments, ['relayUrl'])?.keys).toEqual(['relayUrl'])
    expect(settingsSealRefusal(localAdmin, hideRemoteAndEnvironments, ['projects'])?.keys).toEqual(['projects'])
    expect(settingsSealRefusal(localAdmin, hideRemoteAndEnvironments, ['engineProfiles'])?.keys).toEqual(['engineProfiles'])
  })
})

describe('settings.save under enterprise policy', () => {
  it('refuses to change the sealed setting even for an admin, and writes nothing', async () => {
    registerEnterprisePolicySource(() => SEALED_OFF)
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(tcpAdmin, [{ allowSettingsEdits: true }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'settings_sealed' } })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
  })

  it('accepts a save that repeats the sealed value', async () => {
    registerEnterprisePolicySource(() => SEALED_OFF)
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(tcpAdmin, [{ allowSettingsEdits: false }])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
  })

  it('answers a sealed refusal that names the keys and the class', async () => {
    registerEnterprisePolicySource(() => ({ customFields: { 'ion-server': { settingsPolicy: { keys: { gitOpsMode: { class: 'sealed' } } } } } }))
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(tcpAdmin, [{ gitOpsMode: 'worktree', commitCommand: 'c' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'settings_sealed', keys: ['gitOpsMode'], class: 'sealed' } })
    // Refused whole: the key that was not sealed is not written either.
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it("refuses a hidden group's account key from the local desktop", async () => {
    registerEnterprisePolicySource(() => HIDE_GIT)
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(localAdmin, [{ gitOpsMode: 'worktree' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'settings_hidden' } })
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
  })
})

describe('applyProjectableSetting under enterprise policy', () => {
  it('refuses the sealed key', () => {
    registerEnterprisePolicySource(() => SEALED_OFF)
    const result = applyProjectableSetting('allowSettingsEdits', true, { subject: 'local:operator', scopes: ['admin'], label: 't', transport: 'tcp' })
    expect(result).toMatchObject({ ok: false, code: 'settings_sealed' })
  })

  it("refuses a hidden group's key on the local transport, not on relay", () => {
    registerEnterprisePolicySource(() => HIDE_GIT)
    expect(applyProjectableSetting('gitOpsMode', 'worktree', { subject: 'local:operator', scopes: ['admin'], label: 't', transport: 'local' })).toMatchObject({ ok: false, code: 'settings_hidden' })
    expect(applyProjectableSetting('gitOpsMode', 'worktree', { subject: 'local:operator', scopes: ['admin'], label: 't', transport: 'relay' })).toEqual({ ok: true })
  })
})

describe('planBashAllowlist.set under a settings policy', () => {
  it('is refused when the plan-mode Bash setting is sealed', async () => {
    registerEnterprisePolicySource(() => ({ customFields: { 'ion-server': { settingsPolicy: { keys: { planModeAllowedBashCommands: { class: 'sealed' } } } } } }))
    const outcome = await PROVIDER_ACTIONS['planBashAllowlist.set'].handler(tcpAdmin, [['ls']])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'settings_sealed', keys: ['planModeAllowedBashCommands'], class: 'sealed' } })
    expect(planBash.write).not.toHaveBeenCalled()
  })

  it('writes the list when no policy seals it', async () => {
    const outcome = await PROVIDER_ACTIONS['planBashAllowlist.set'].handler(tcpAdmin, [['ls']])
    expect(outcome).toEqual({ ok: true, value: null })
    expect(planBash.write).toHaveBeenCalledWith(['ls'])
  })
})

describe('the projected schema under a settings policy', () => {
  it('marks a sealed key so a thin client renders it read-only', () => {
    registerEnterprisePolicySource(() => ({ customFields: { 'ion-server': { settingsPolicy: { keys: { gitOpsMode: { class: 'sealed' } } } } } }))
    const schema = projectableSchema()
    expect(schema.find((entry) => entry.key === 'gitOpsMode')?.sealed).toBe(true)
    expect(schema.find((entry) => entry.key === 'worktreeCompletionStrategy')?.sealed).toBeUndefined()
  })
})

describe('settings.policyState', () => {
  const both = { customFields: {
    'ion-server': { settingsPolicy: { keys: { gitOpsMode: { class: 'sealed', value: 'zz-sealed-value' } } } },
    'ion-desktop': { settingsPolicy: { keys: { uiZoom: { class: 'sealed' } } } },
  } }

  it('answers classes and a checksum, never a value', async () => {
    registerEnterprisePolicySource(() => both)
    const outcome = await SETTINGS_ACTIONS['settings.policyState'].handler(localAdmin, [])
    expect(outcome).toMatchObject({ ok: true, value: { schemaVersion: 1, keys: { gitOpsMode: { class: 'sealed' }, uiZoom: { class: 'sealed' } } } })
    expect(JSON.stringify(outcome)).not.toContain('zz-sealed-value')
    expect((outcome as { value: { checksum: string } }).value.checksum).toMatch(/^sha256:/)
  })

  it('tells a visiting connection about the server namespace only', async () => {
    registerEnterprisePolicySource(() => both)
    const outcome = await SETTINGS_ACTIONS['settings.policyState'].handler(tcpAdmin, []) as { value: { keys: Record<string, unknown> } }
    expect(outcome.value.keys.gitOpsMode).toBeDefined()
    expect(outcome.value.keys.uiZoom).toBeUndefined()
  })
})

describe('preferences.declare under device policy', () => {
  const sealMode = { customFields: { 'ion-desktop': { settingsPolicy: { keys: { defaultPermissionMode: { class: 'sealed', value: 'plan' } } } } } }

  it('holds the sealed value for the local desktop, whatever it declared', async () => {
    registerEnterprisePolicySource(() => sealMode)
    const local = { ...localAdmin, preferences: {} } as unknown as Connection
    await SETTINGS_ACTIONS['preferences.declare'].handler(local, [{ defaultPermissionMode: 'auto' }])
    expect(local.preferences.defaultPermissionMode).toBe('plan')
    const visitor = { ...tcpAdmin, preferences: {} } as unknown as Connection
    await SETTINGS_ACTIONS['preferences.declare'].handler(visitor, [{ defaultPermissionMode: 'auto' }])
    expect(visitor.preferences.defaultPermissionMode).toBe('auto')
  })
})

describe('studio.setSetting under device policy', () => {
  const sealTheme = { customFields: { 'ion-desktop': { settingsPolicy: { keys: { studioTheme: { class: 'sealed', value: 'ion-works' } } } } } }

  it('refuses a sealed Studio key from the local desktop and serves the sealed value', async () => {
    registerEnterprisePolicySource(() => sealTheme)
    const refused = await STUDIO_SETTINGS_ACTIONS['studio.setSetting'].handler(localAdmin, ['studioTheme', 'other-theme'])
    expect(refused).toMatchObject({ ok: false, error: { code: 'settings_sealed', keys: ['studioTheme'], class: 'sealed' } })
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
    deps.readSettingsForSubject.mockReturnValue({ studioTheme: 'other-theme' })
    const read = await STUDIO_SETTINGS_ACTIONS['studio.getSettings'].handler(localAdmin, []) as { value: Record<string, unknown> }
    expect(read.value.studioTheme).toBe('ion-works')
  })

  it('leaves a visiting client alone', async () => {
    registerEnterprisePolicySource(() => sealTheme)
    const saved = await STUDIO_SETTINGS_ACTIONS['studio.setSetting'].handler(tcpAdmin, ['studioTheme', 'other-theme'])
    expect(saved).toEqual({ ok: true, value: true })
    deps.readSettingsForSubject.mockReturnValue({ studioTheme: 'other-theme' })
    const read = await STUDIO_SETTINGS_ACTIONS['studio.getSettings'].handler(tcpAdmin, []) as { value: Record<string, unknown> }
    expect(read.value.studioTheme).toBe('other-theme')
  })
})
