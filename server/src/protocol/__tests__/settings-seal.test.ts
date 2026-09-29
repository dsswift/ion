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
  readSettingsForSubject: vi.fn(() => ({})),
}))
vi.mock('../../persistence/settings-store', () => ({ readSettings: deps.readSettings }))
vi.mock('../../settings-broadcast', () => ({ persistAndBroadcastSettings: deps.persistAndBroadcastSettings, broadcastDesktopSettingsSnapshot: vi.fn() }))
vi.mock('../../persistence/user-settings-store', () => ({ writeSettingsForSubject: deps.writeSettingsForSubject, readSettingsForSubject: deps.readSettingsForSubject }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))

import { SETTINGS_ACTIONS } from '../settings-actions'
import { settingsSealRefusal } from '../settings-seal'
import { registerEnterprisePolicySource } from '../../enterprise-policy-source'
import { applyProjectableSetting } from '../../remote/handlers/desktop-settings'
import type { Connection } from '../connection'

const localAdmin = { id: 'l', transport: 'local', scopes: ['conversations:read', 'admin'], principal: { subject: 'local:operator' } } as unknown as Connection
const tcpAdmin = { id: 'a', transport: 'tcp', scopes: ['conversations:read', 'admin'], principal: { subject: 'local:operator' } } as unknown as Connection

const SEALED_OFF = { customFields: { 'ion-server': { agentSettingsEdits: { allowed: false } } } }
const HIDE_GIT = { customFields: { 'ion-desktop': { hiddenSettingsGroups: ['git'] } } }

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockClear()
  deps.readSettings.mockReturnValue({ allowSettingsEdits: false })
  registerEnterprisePolicySource(() => null)
})

describe('settingsSealRefusal', () => {
  it('refuses a sealed key for every connection, admin included', () => {
    expect(settingsSealRefusal(tcpAdmin, SEALED_OFF, ['allowSettingsEdits'])?.code).toBe('settings_sealed')
    expect(settingsSealRefusal(tcpAdmin, null, ['allowSettingsEdits'])).toBeNull()
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
