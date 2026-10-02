/**
 * Applying the enterprise settings policy: the state file a management
 * system reads, and a managed default that is supplied once per value.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
const sent = vi.hoisted(() => ({ broadcast: vi.fn(), snapshot: vi.fn() }))
vi.mock('../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
vi.mock('../store/session-store-force-flush', () => ({ forceFlushTabs: vi.fn() }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: sent.broadcast }))
vi.mock('../projectable-settings', () => ({
  isProjectableKey: (key: string) => key === 'tabRecoveryTimeoutSec',
  validateSettingValue: (_key: string, value: unknown) => (typeof value === 'number' ? null : 'expects number'),
}))
vi.mock('../settings-broadcast', async () => {
  const store = await import('../persistence/settings-store')
  return {
    persistAndBroadcastSettings: (next: Record<string, unknown>) => store.writeSettings(next),
    broadcastDesktopSettingsSnapshot: sent.snapshot,
  }
})

import { readSettings, writeSettings } from '../persistence/settings-store'
import { readSettingsForSubject, writeSettingsForSubject } from '../persistence/user-settings-store'
import { registerEnterprisePolicySource } from '../enterprise-policy-source'
import { applySettingsPolicy, SETTINGS_POLICY_STATE_FILENAME, _resetSettingsPolicyApplyForTest } from '../settings-policy-apply'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

const SUBJECT = 'local:operator'
const policy = (keys: Record<string, unknown>, defaultClass?: string): EnterprisePolicy =>
  ({ customFields: { 'ion-server': { settingsPolicy: { version: 'r7', ...(defaultClass ? { defaultClass } : {}), keys } } } })

/** Apply the way a server start does: a fresh process, the policy already in force. */
function start(p: EnterprisePolicy | null): void {
  _resetSettingsPolicyApplyForTest()
  registerEnterprisePolicySource(() => p)
  applySettingsPolicy(p, 'test')
}

const state = (): Record<string, any> => JSON.parse(readFileSync(join(paths.dir, SETTINGS_POLICY_STATE_FILENAME), 'utf-8'))

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-settings-policy-'))
  sent.broadcast.mockClear()
  sent.snapshot.mockClear()
  _resetSettingsPolicyApplyForTest()
  registerEnterprisePolicySource(() => null)
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('applySettingsPolicy', () => {
  it('writes the applied class of every key, the policy checksum, and no value', () => {
    start(policy({ gitOpsMode: { class: 'sealed', value: 'zz-sealed-value' }, commitCommand: { class: 'managed-default', value: 'zz-default-value' } }, 'sealed'))
    const written = state()
    expect(written.schemaVersion).toBe(1)
    expect(written.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(written.namespaces['ion-server']).toEqual({ version: 'r7', defaultClass: 'sealed' })
    expect(written.keys.gitOpsMode).toEqual({ class: 'sealed', source: 'key', namespace: 'ion-server' })
    expect(written.keys.commitCommand.class).toBe('managed-default')
    expect(written.keys.relayUrl).toEqual({ class: 'sealed', source: 'default', namespace: 'ion-server' })
    const text = JSON.stringify(written)
    expect(text).not.toContain('zz-sealed-value')
    expect(text).not.toContain('zz-default-value')
  })

  it('reports every key user-adjustable with no policy', () => {
    start(null)
    expect(Object.values(state().keys).every((k: any) => k.class === 'user-adjustable')).toBe(true)
    const unmanaged = state().checksum
    start(policy({}, 'sealed'))
    expect(state().checksum).not.toBe(unmanaged)
  })

  it('supplies a managed default once, and leaves a later change by the person alone', () => {
    const p = policy({ tabRecoveryTimeoutSec: { class: 'managed-default', value: 300 } })
    start(p)
    expect(readSettings().tabRecoveryTimeoutSec).toBe(300)
    writeSettings({ ...readSettings(), tabRecoveryTimeoutSec: 90 })
    start(p)
    expect(readSettings().tabRecoveryTimeoutSec).toBe(90)
  })

  it('supplies the new value when the policy changes it', () => {
    start(policy({ tabRecoveryTimeoutSec: { class: 'managed-default', value: 300 } }))
    writeSettings({ ...readSettings(), tabRecoveryTimeoutSec: 90 })
    start(policy({ tabRecoveryTimeoutSec: { class: 'managed-default', value: 240 } }))
    expect(readSettings().tabRecoveryTimeoutSec).toBe(240)
  })

  it('does not supply a value that is not valid for the setting', () => {
    start(policy({ tabRecoveryTimeoutSec: { class: 'managed-default', value: 'soon' } }))
    expect('tabRecoveryTimeoutSec' in readSettings()).toBe(false)
  })

  it('makes an Account managed default reach a person who had set their own value', () => {
    writeSettingsForSubject(SUBJECT, { gitOpsMode: 'manual', commitCommand: 'mine' })
    start(policy({ gitOpsMode: { class: 'managed-default', value: 'worktree' } }))
    expect(readSettingsForSubject(SUBJECT).gitOpsMode).toBe('worktree')
    // Their other settings are untouched, and they may set this one again.
    expect(readSettingsForSubject(SUBJECT).commitCommand).toBe('mine')
    writeSettingsForSubject(SUBJECT, { gitOpsMode: 'manual' })
    expect(readSettingsForSubject(SUBJECT).gitOpsMode).toBe('manual')
  })

  it('tells connected clients the value in force when a seal arrives and when it lifts', () => {
    writeSettings({ tabRecoveryTimeoutSec: 60 })
    start(null)
    const sealed = policy({ tabRecoveryTimeoutSec: { class: 'sealed', value: 300 } })
    registerEnterprisePolicySource(() => sealed)
    applySettingsPolicy(sealed, 'changed')
    expect(sent.broadcast).toHaveBeenCalledWith('ion:settings-changed', 'tabRecoveryTimeoutSec', 300)
    expect(sent.snapshot).toHaveBeenCalled()
    registerEnterprisePolicySource(() => null)
    applySettingsPolicy(null, 'changed')
    expect(sent.broadcast).toHaveBeenLastCalledWith('ion:settings-changed', 'tabRecoveryTimeoutSec', 60)
  })

  it('does nothing when the settings inputs of the policy have not changed', () => {
    const p = policy({ gitOpsMode: { class: 'sealed' } })
    start(p)
    rmSync(join(paths.dir, SETTINGS_POLICY_STATE_FILENAME))
    applySettingsPolicy({ ...p, allowedModels: ['m'] }, 'reconnect')
    expect(existsSync(join(paths.dir, SETTINGS_POLICY_STATE_FILENAME))).toBe(false)
  })
})
