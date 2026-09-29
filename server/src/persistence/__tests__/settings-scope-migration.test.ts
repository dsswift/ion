/**
 * The one-time move of Environment settings out of the local account's
 * overlay. The promise it keeps: the server acts on the same value after the
 * move as before it, so auto-settle cannot switch on anywhere it was off.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
vi.mock('../../store/session-store-force-flush', () => ({ forceFlushTabs: vi.fn() }))

import { readSettings } from '../settings-store'
import { listOverlays, readSettingsForSubject, replaceOverlay } from '../user-settings-store'
import { runSettingsScopeMigration, SETTINGS_SCOPE_MARKER_FILENAME } from '../settings-scope-migration'

const LOCAL = 'local:operator'

beforeEach(() => { paths.dir = mkdtempSync(join(tmpdir(), 'ion-scope-migration-')) })
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

function shared(doc: Record<string, unknown>): void {
  writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify(doc))
}

describe('runSettingsScopeMigration', () => {
  it('keeps the auto-settle value the server was already acting on', () => {
    // The operator turned auto-settle OFF in Settings; that landed in their
    // overlay. The shared document still carries an old 3.
    shared({ inboxAutoSettleDays: 3 })
    replaceOverlay(LOCAL, { inboxAutoSettleDays: 0, preferredModel: 'm' })

    const result = runSettingsScopeMigration(LOCAL, paths.dir)

    expect(result.promoted).toEqual(['inboxAutoSettleDays'])
    expect(readSettings().inboxAutoSettleDays).toBe(0)
    expect(readSettingsForSubject(LOCAL).inboxAutoSettleDays).toBe(0)
    // The Account setting stays in the overlay, where it belongs.
    expect(listOverlays()[0].settings).toEqual({ preferredModel: 'm' })
  })

  it('leaves a shared value alone when the overlay has none', () => {
    shared({ inboxAutoSettleDays: 5 })
    replaceOverlay(LOCAL, { preferredModel: 'm' })
    expect(runSettingsScopeMigration(LOCAL, paths.dir).promoted).toEqual([])
    expect(readSettings().inboxAutoSettleDays).toBe(5)
  })

  it("does not promote another person's value over the server's", () => {
    shared({ inboxAutoSettleDays: 0 })
    replaceOverlay('user:guest', { inboxAutoSettleDays: 3 })
    expect(runSettingsScopeMigration(LOCAL, paths.dir).promoted).toEqual([])
    expect(readSettings().inboxAutoSettleDays).toBe(0)
    expect(readSettingsForSubject('user:guest').inboxAutoSettleDays).toBe(0)
  })

  it('backs both files up before writing, and is a no-op on the second boot', () => {
    shared({ inboxAutoSettleDays: 3 })
    replaceOverlay(LOCAL, { inboxAutoSettleDays: 0 })
    runSettingsScopeMigration(LOCAL, paths.dir)

    expect(JSON.parse(readFileSync(join(paths.dir, 'settings.json.pre-scope.bak'), 'utf-8'))).toEqual({ inboxAutoSettleDays: 3 })
    expect(existsSync(join(paths.dir, SETTINGS_SCOPE_MARKER_FILENAME))).toBe(true)

    // A value that reaches the overlay later is not swept up by a rerun.
    replaceOverlay(LOCAL, { inboxAutoSettleDays: 9 })
    expect(runSettingsScopeMigration(LOCAL, paths.dir)).toEqual({ ran: false, promoted: [] })
    expect(readSettings().inboxAutoSettleDays).toBe(0)
  })
})
