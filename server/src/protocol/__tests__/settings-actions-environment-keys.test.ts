/**
 * `settings.save` routes each key to its owner: environment-owned keys to
 * settings.json (only for a connection holding `admin`, from any transport),
 * server-owned keys nowhere (disk wins), everything else to the caller's
 * overlay.
 *
 * The gate used to be the connection's transport. That locked a server's own
 * operator out of it from every device but the one it ran on, and let a
 * guest who happened to sit on the local socket change it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const deps = vi.hoisted(() => ({
  readSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  persistAndBroadcastSettings: vi.fn(),
  broadcastDesktopSettingsSnapshot: vi.fn(),
  writeSettingsForSubject: vi.fn(),
  readSettingsForSubject: vi.fn(() => ({})),
}))
vi.mock('../../persistence/settings-store', () => ({ readSettings: deps.readSettings }))
vi.mock('../../settings-broadcast', () => ({ persistAndBroadcastSettings: deps.persistAndBroadcastSettings, broadcastDesktopSettingsSnapshot: deps.broadcastDesktopSettingsSnapshot }))
vi.mock('../../persistence/user-settings-store', () => ({ writeSettingsForSubject: deps.writeSettingsForSubject, readSettingsForSubject: deps.readSettingsForSubject }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { SETTINGS_ACTIONS, partitionSettingsPatch } from '../settings-actions'
import type { Connection } from '../connection'

const local = { id: 'l', transport: 'local', scopes: ['conversations:read', 'admin'], principal: { subject: 'local:operator' } } as unknown as Connection
const tcp = { id: 't', transport: 'tcp', scopes: ['conversations:read', 'conversations:operate'], principal: { subject: 'oidc:alice' } } as unknown as Connection
const tcpAdmin = { id: 'a', transport: 'tcp', scopes: ['conversations:read', 'admin'], principal: { subject: 'local:operator' } } as unknown as Connection

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockClear()
  deps.readSettings.mockReturnValue({ streamThinkingToRemote: false, relayUrl: '', pairedDevices: [{ id: 'phone' }] })
})

describe('partitionSettingsPatch', () => {
  it('splits environment, personal and server-owned keys', () => {
    expect(partitionSettingsPatch({ streamThinkingToRemote: true, gitOpsMode: 'manual', pairedDevices: [] })).toEqual({
      environment: { streamThinkingToRemote: true },
      personal: { gitOpsMode: 'manual' },
      droppedServerOwned: ['pairedDevices'],
      clientOwned: [],
    })
  })
})

describe('settings.save', () => {
  it('writes environment keys to settings.json for a connection holding admin', async () => {
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(local, [{ streamThinkingToRemote: true, relayUrl: 'wss://r', gitOpsMode: 'worktree', pairedDevices: [] }])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    const prev = { streamThinkingToRemote: false, relayUrl: '', pairedDevices: [{ id: 'phone' }] }
    const merged = { ...prev, streamThinkingToRemote: true, relayUrl: 'wss://r' }
    expect(deps.persistAndBroadcastSettings).toHaveBeenCalledWith(merged, prev)
    // The stale pairedDevices from the client never reached disk.
    expect((deps.persistAndBroadcastSettings.mock.calls[0]![0] as Record<string, unknown>).pairedDevices).toEqual([{ id: 'phone' }])
    // Personal keys went to the overlay, environment keys did not.
    expect(deps.writeSettingsForSubject).toHaveBeenCalledWith('local:operator', { gitOpsMode: 'worktree' })
  })

  it('does not rewrite settings.json when the environment keys are unchanged', async () => {
    await SETTINGS_ACTIONS['settings.save'].handler(local, [{ streamThinkingToRemote: false, relayUrl: '', gitOpsMode: 'manual' }])
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
    expect(deps.writeSettingsForSubject).toHaveBeenCalledWith('local:operator', { gitOpsMode: 'manual' })
  })

  it('refuses a connection without admin that would change an environment key, applying nothing', async () => {
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(tcp, [{ streamThinkingToRemote: true, gitOpsMode: 'manual' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'settings_locked' } })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it('gates on the admin scope, not on the transport', async () => {
    // Auto-settle is the setting this rule exists for: one value per server,
    // changeable by its operator from any of their devices and by nobody else.
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(tcpAdmin, [{ inboxAutoSettleDays: 3 }])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect((deps.persistAndBroadcastSettings.mock.calls[0]![0] as Record<string, unknown>).inboxAutoSettleDays).toBe(3)
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()

    deps.persistAndBroadcastSettings.mockClear()
    const localGuest = { ...local, scopes: ['conversations:read'] } as unknown as Connection
    expect(await SETTINGS_ACTIONS['settings.save'].handler(localGuest, [{ inboxAutoSettleDays: 3 }])).toMatchObject({ ok: false, error: { code: 'settings_locked' } })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
  })

  it('does not refuse a patch that only repeats the environment value already on disk', async () => {
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(tcp, [{ streamThinkingToRemote: false, gitOpsMode: 'manual' }])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
    expect(deps.writeSettingsForSubject).toHaveBeenCalledWith('oidc:alice', { gitOpsMode: 'manual' })
  })

  it('refuses a key that belongs to the client, storing nothing', async () => {
    // A Personal preference or a Device setting lives on the client. Storing
    // one here would recreate the server-held copy that went stale.
    const outcome = await SETTINGS_ACTIONS['settings.save'].handler(local, [{ selectedTheme: 'dusk', defaultThinkingEffort: 'high', gitOpsMode: 'manual' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'settings_wrong_scope' } })
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
  })

  it('lets a connection without admin save its own personal keys', async () => {
    await SETTINGS_ACTIONS['settings.save'].handler(tcp, [{ gitOpsMode: 'manual', pairedDevices: [] }])
    expect(deps.writeSettingsForSubject).toHaveBeenCalledWith('oidc:alice', { gitOpsMode: 'manual' })
  })

  it('refreshes the phones projected snapshot when an account key changes', async () => {
    // A phone of the same person shows gitOpsMode from this overlay; without
    // the refresh it kept the old value until something else rebroadcast.
    deps.readSettingsForSubject.mockReturnValueOnce({ gitOpsMode: 'worktree' })
    await SETTINGS_ACTIONS['settings.save'].handler(tcp, [{ gitOpsMode: 'manual' }])
    expect(deps.broadcastDesktopSettingsSnapshot).toHaveBeenCalledTimes(1)
  })

  it('sends no snapshot when the account keys repeat what the overlay already holds', async () => {
    deps.readSettingsForSubject.mockReturnValueOnce({ gitOpsMode: 'manual' })
    await SETTINGS_ACTIONS['settings.save'].handler(tcp, [{ gitOpsMode: 'manual' }])
    expect(deps.writeSettingsForSubject).toHaveBeenCalled()
    expect(deps.broadcastDesktopSettingsSnapshot).not.toHaveBeenCalled()
  })
})

describe('settings.load', () => {
  const stored = { relayUrl: 'wss://r', relayApiKey: 'psk-secret', pairedDevices: [{ id: 'phone', sharedSecret: 's3cret', relayOidcSubject: 'sub', label: 'Phone' }] }

  it('gives a connection holding admin the whole document', async () => {
    deps.readSettingsForSubject.mockReturnValueOnce(stored)
    expect(await SETTINGS_ACTIONS['settings.load'].handler(tcpAdmin, [])).toEqual({ ok: true, value: stored })
  })

  it('leaves the relay key and paired devices\' secrets out for everyone else', async () => {
    deps.readSettingsForSubject.mockReturnValueOnce(stored)
    expect(await SETTINGS_ACTIONS['settings.load'].handler(tcp, [])).toEqual({
      ok: true,
      value: { relayUrl: 'wss://r', pairedDevices: [{ id: 'phone', label: 'Phone' }] },
    })
  })
})
