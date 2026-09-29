// @vitest-environment jsdom
/**
 * Each server's settings are kept apart, and apart from this client's own
 * preferences. The bug behind this store: every surface read one flat local
 * store, so a conversation on another server showed the local server's
 * default model, and Settings always edited the local server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  listener: null as null | ((environmentId: string, frame: Record<string, unknown>) => void),
  action: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../../host/host-instance', () => ({
  host: { onFrame: (cb: typeof wire.listener) => { wire.listener = cb; return () => { wire.listener = null } } },
  action: wire.action,
}))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

import {
  canManageEnvironment, environmentSetting, initEnvironmentSettingsFromWire, saveEnvironmentSettings, useEnvironmentSettingsStore,
} from '../environment-settings-store'

const welcome = (settings: Record<string, unknown>, scopes: string[]) => ({ type: 'studio_welcome', scopes, snapshot: { settings } })

beforeEach(() => {
  useEnvironmentSettingsStore.setState({ byEnvironment: {} })
  wire.action.mockReset()
  wire.action.mockResolvedValue({ ok: true })
  initEnvironmentSettingsFromWire()
})

describe('environment settings store', () => {
  it('refreshes from a snapshot and keeps the scopes the welcome granted', () => {
    // A window attached after the welcome is handed that welcome again and
    // then a fresh snapshot; the snapshot's settings are current, but it
    // carries no scopes.
    wire.listener!('local', welcome({ preferredModel: 'old-model' }, ['admin']))
    wire.listener!('local', { type: 'studio_snapshot', snapshot: { settings: { preferredModel: 'new-model' } } })
    const s = useEnvironmentSettingsStore.getState()
    expect(environmentSetting(s, 'local', 'preferredModel')).toBe('new-model')
    expect(canManageEnvironment(s, 'local')).toBe(true)
  })

  it('keeps each server apart', () => {
    wire.listener!('local', welcome({ preferredModel: 'claude-sonnet-5', inboxAutoSettleDays: 0 }, ['admin']))
    wire.listener!('env-remote', welcome({ preferredModel: 'acme-gateway/claude-sonnet-5', inboxAutoSettleDays: 3 }, ['conversations:operate']))
    const s = useEnvironmentSettingsStore.getState()
    expect(environmentSetting(s, 'local', 'preferredModel')).toBe('claude-sonnet-5')
    expect(environmentSetting(s, 'env-remote', 'preferredModel')).toBe('acme-gateway/claude-sonnet-5')
    expect(environmentSetting(s, 'env-remote', 'inboxAutoSettleDays')).toBe(3)
    expect(environmentSetting(s, 'never-connected', 'preferredModel')).toBeUndefined()
  })

  it('holds server settings only: client-owned keys never enter', () => {
    wire.listener!('env-remote', welcome({ preferredModel: 'm', selectedTheme: 'dusk', defaultThinkingEffort: 'high' }, []))
    expect(useEnvironmentSettingsStore.getState().byEnvironment['env-remote'].settings).toEqual({ preferredModel: 'm' })
  })

  it('follows that server, and only that server, when a setting changes', () => {
    wire.listener!('local', welcome({ inboxAutoSettleDays: 0 }, ['admin']))
    wire.listener!('env-remote', welcome({ inboxAutoSettleDays: 3 }, ['admin']))
    wire.listener!('env-remote', { type: 'studio_event', channel: 'ion:settings-changed', payload: ['inboxAutoSettleDays', 7] })
    const s = useEnvironmentSettingsStore.getState()
    expect(environmentSetting(s, 'env-remote', 'inboxAutoSettleDays')).toBe(7)
    expect(environmentSetting(s, 'local', 'inboxAutoSettleDays')).toBe(0)
  })

  it('says a connection may manage a server only when it holds admin there', () => {
    wire.listener!('local', welcome({}, ['conversations:read', 'admin']))
    wire.listener!('env-remote', welcome({}, ['conversations:read', 'git:write']))
    const s = useEnvironmentSettingsStore.getState()
    expect(canManageEnvironment(s, 'local')).toBe(true)
    expect(canManageEnvironment(s, 'env-remote')).toBe(false)
    expect(canManageEnvironment(s, 'never-connected')).toBe(false)
  })

  it('saves to the named server and keeps the new value', async () => {
    wire.listener!('env-remote', welcome({ inboxAutoSettleDays: 0 }, ['admin']))
    await saveEnvironmentSettings('env-remote', { inboxAutoSettleDays: 5 })
    expect(wire.action).toHaveBeenCalledWith('env-remote', 'settings.save', [{ inboxAutoSettleDays: 5 }])
    expect(environmentSetting(useEnvironmentSettingsStore.getState(), 'env-remote', 'inboxAutoSettleDays')).toBe(5)
  })

  it('puts the old value back when the server refuses', async () => {
    wire.listener!('env-remote', welcome({ inboxAutoSettleDays: 0 }, []))
    wire.action.mockRejectedValueOnce(new Error('changing inboxAutoSettleDays requires the admin scope on this server'))
    await expect(saveEnvironmentSettings('env-remote', { inboxAutoSettleDays: 5 })).rejects.toThrow('admin')
    expect(environmentSetting(useEnvironmentSettingsStore.getState(), 'env-remote', 'inboxAutoSettleDays')).toBe(0)
  })

  it('never sends a client-owned setting to a server', async () => {
    await expect(saveEnvironmentSettings('env-remote', { selectedTheme: 'dusk' })).rejects.toThrow('not a server setting')
    expect(wire.action).not.toHaveBeenCalled()
  })
})
