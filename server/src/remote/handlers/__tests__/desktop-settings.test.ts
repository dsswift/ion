/**
 * applyProjectableSetting is the one write to a projectable setting from a
 * client that renders the projected list (the phone). It routes by the key's
 * scope in the settings registry, the same way `settings.save` does, and it
 * answers why a write was not applied.
 *
 * The bug this pins: the phone wrote every key to the shared Environment
 * document while Studio wrote personal keys to the caller's overlay. The
 * overlay shadows the shared document on every read, so a change made on the
 * phone silently did nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  readSettings: vi.fn((): Record<string, unknown> => ({ inboxAutoSettleDays: 0, other: 1 })),
  writeSettingsForSubject: vi.fn(),
  persistAndBroadcastSettings: vi.fn(),
  broadcastDesktopSettingsSnapshot: vi.fn(),
  broadcast: vi.fn(),
  isProjectableKey: vi.fn((key: string) => key !== 'notASetting'),
  validateSettingValue: vi.fn((_key: string, value: unknown): string | null => (value === 'wrong-type' ? 'expected a boolean' : null)),
}))
vi.mock('../../../persistence/settings-store', () => ({ readSettings: deps.readSettings }))
vi.mock('../../../persistence/user-settings-store', () => ({ writeSettingsForSubject: deps.writeSettingsForSubject }))
vi.mock('../../../settings-broadcast', () => ({ persistAndBroadcastSettings: deps.persistAndBroadcastSettings, broadcastDesktopSettingsSnapshot: deps.broadcastDesktopSettingsSnapshot }))
vi.mock('../../../broadcast', () => ({ broadcast: deps.broadcast }))
vi.mock('../../../projectable-settings', () => ({ isProjectableKey: deps.isProjectableKey, validateSettingValue: deps.validateSettingValue, PROJECTABLE_SETTINGS: [] }))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { applyProjectableSetting, type ProjectableSettingCaller } from '../desktop-settings'

const admin: ProjectableSettingCaller = { subject: 'local:operator', scopes: ['conversations:operate', 'admin'], label: 'client=abc' }
const guest: ProjectableSettingCaller = { subject: 'user:guest', scopes: ['conversations:read', 'conversations:operate'], label: 'client=def' }

beforeEach(() => {
  for (const fn of [deps.persistAndBroadcastSettings, deps.broadcast, deps.writeSettingsForSubject, deps.broadcastDesktopSettingsSnapshot]) fn.mockReset()
})

describe('applyProjectableSetting', () => {
  it("writes a non-Environment key to the CALLER's overlay, never the shared document", () => {
    expect(applyProjectableSetting('gitOpsMode', 'worktree', guest)).toEqual({ ok: true })
    expect(deps.writeSettingsForSubject).toHaveBeenCalledWith('user:guest', { gitOpsMode: 'worktree' })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
    // Routed to the owner only: the third argument names them.
    expect(deps.broadcast).toHaveBeenCalledWith('ion:settings-changed', 'gitOpsMode', 'worktree', 'user:guest')
    expect(deps.broadcastDesktopSettingsSnapshot).toHaveBeenCalledTimes(1)
  })

  it('writes an Environment key to the shared document for a caller holding admin', () => {
    expect(applyProjectableSetting('inboxAutoSettleDays', 3, admin)).toEqual({ ok: true })
    expect(deps.persistAndBroadcastSettings).toHaveBeenCalledWith({ inboxAutoSettleDays: 3, other: 1 }, { inboxAutoSettleDays: 0, other: 1 })
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it('refuses an Environment key from a caller without admin, writing nothing anywhere', () => {
    expect(applyProjectableSetting('inboxAutoSettleDays', 3, guest)).toEqual({
      ok: false, code: 'admin_required', message: 'changing inboxAutoSettleDays requires the admin scope on this server',
    })
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
    expect(deps.broadcast).not.toHaveBeenCalled()
  })

  it('refuses a key that is not projectable and a value of the wrong type, writing nothing', () => {
    expect(applyProjectableSetting('notASetting', true, admin)).toEqual({ ok: false, code: 'unknown_key', message: 'notASetting is not a projectable setting' })
    expect(applyProjectableSetting('gitOpsMode', 'wrong-type', admin)).toEqual({ ok: false, code: 'invalid_value', message: 'expected a boolean' })
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
  })

  it('refuses a key the client keeps itself, writing nothing', () => {
    // The theme is a Device setting and the thinking level a Personal
    // preference: both live on the client that chose them.
    for (const key of ['selectedTheme', 'defaultThinkingEffort']) {
      expect(applyProjectableSetting(key, 'x', admin)).toEqual({ ok: false, code: 'wrong_scope', message: `${key} is kept on the client, not on a server` })
    }
    expect(deps.writeSettingsForSubject).not.toHaveBeenCalled()
    expect(deps.persistAndBroadcastSettings).not.toHaveBeenCalled()
  })

  it('reports a failed write and tells no client', () => {
    deps.writeSettingsForSubject.mockImplementation(() => { throw new Error('disk full') })
    expect(applyProjectableSetting('gitOpsMode', 'manual', admin)).toEqual({ ok: false, code: 'write_failed', message: 'Error: disk full' })
    expect(deps.broadcast).not.toHaveBeenCalled()
  })
})
