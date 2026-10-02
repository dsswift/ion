/**
 * A setting the enterprise policy seals to a value reads as that value, and
 * the value a person saved stays on disk underneath, so it is back when the
 * seal lifts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
vi.mock('../../store/session-store-force-flush', () => ({ forceFlushTabs: vi.fn() }))

import { readSettings, readStoredSettings, writeSettings } from '../settings-store'
import { readSettingsForSubject, writeSettingsForSubject } from '../user-settings-store'
import { registerEnterprisePolicySource } from '../../enterprise-policy-source'

const SUBJECT = 'local:operator'
const SEALED = { customFields: { 'ion-server': { settingsPolicy: { keys: {
  tabRecoveryTimeoutSec: { class: 'sealed', value: 300 },
  gitOpsMode: { class: 'sealed', value: 'worktree' },
  commitCommand: { class: 'sealed' },
} } } } }

const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(join(paths.dir, 'settings.json'), 'utf-8'))

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-sealed-settings-'))
  registerEnterprisePolicySource(() => null)
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('sealed settings at the persistence layer', () => {
  it('reads the policy value in place of the stored one', () => {
    writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ tabRecoveryTimeoutSec: 60, relayUrl: 'wss://relay.example.org' }))
    expect(readSettings().tabRecoveryTimeoutSec).toBe(60)
    registerEnterprisePolicySource(() => SEALED)
    expect(readSettings().tabRecoveryTimeoutSec).toBe(300)
    expect(readSettings().relayUrl).toBe('wss://relay.example.org')
    expect(readStoredSettings().tabRecoveryTimeoutSec).toBe(60)
  })

  it('keeps the stored value on disk when a writer saves the document it read', () => {
    writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ tabRecoveryTimeoutSec: 60 }))
    registerEnterprisePolicySource(() => SEALED)
    // Read-modify-write, the way every server writer does it.
    writeSettings({ ...readSettings(), relayUrl: 'wss://relay.example.org' })
    expect(onDisk().tabRecoveryTimeoutSec).toBe(60)
    expect(onDisk().relayUrl).toBe('wss://relay.example.org')
    // A sealed key that was never stored is not created by the policy value.
    expect('gitOpsMode' in onDisk()).toBe(false)
    registerEnterprisePolicySource(() => null)
    expect(readSettings().tabRecoveryTimeoutSec).toBe(60)
  })

  it('does not let a person\'s overlay shadow a sealed Account setting', () => {
    writeSettingsForSubject(SUBJECT, { gitOpsMode: 'manual' })
    expect(readSettingsForSubject(SUBJECT).gitOpsMode).toBe('manual')
    registerEnterprisePolicySource(() => SEALED)
    expect(readSettingsForSubject(SUBJECT).gitOpsMode).toBe('worktree')
    registerEnterprisePolicySource(() => null)
    expect(readSettingsForSubject(SUBJECT).gitOpsMode).toBe('manual')
  })

  it('leaves a setting sealed with no value reading as stored, and unchanged by any writer', () => {
    writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ commitCommand: 'commit --smart' }))
    writeSettingsForSubject(SUBJECT, { commitCommand: 'mine' })
    registerEnterprisePolicySource(() => SEALED)
    expect(readSettings().commitCommand).toBe('commit --smart')
    // A writer that never passed a refusal gate still cannot move it.
    writeSettings({ ...readSettings(), commitCommand: 'changed' })
    expect(onDisk().commitCommand).toBe('commit --smart')
    writeSettingsForSubject(SUBJECT, { commitCommand: 'changed', worktreeSkipPrTitle: true })
    expect(readSettingsForSubject(SUBJECT).commitCommand).toBe('mine')
    expect(readSettingsForSubject(SUBJECT).worktreeSkipPrTitle).toBe(true)
  })
})
