/**
 * A retired feature's saved settings are dropped from every document once,
 * with a backup beside each file, and never touched again.
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import { runRetirement, runRetiredSettingsMigrations, stripRetiredKeys, RETIRED_TAB_GROUPS, RETIRED_PANEL_SETTINGS } from '../settings-retired-keys-migration'
import { readSettings } from '../settings-store'
import { listOverlays } from '../user-settings-store'

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-tab-groups-'))
  writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ tabGroupMode: 'manual', tabGroups: [{ id: 'g1' }], studioTabStripVisible: false, inboxAutoSettleDays: 3 }))
  mkdirSync(join(paths.dir, 'user-settings'))
  writeFileSync(join(paths.dir, 'user-settings', 'abc.json'), JSON.stringify({ subject: 'user:example', settings: { doneGroupId: 'g1', preferredModel: 'm' } }))
})

describe('stripRetiredKeys', () => {
  it('drops only the retired keys', () => {
    const { next, removed } = stripRetiredKeys({ tabGroups: [], autoGroupMovement: true, gitOpsMode: 'manual' }, RETIRED_TAB_GROUPS.keys)
    expect(next).toEqual({ gitOpsMode: 'manual' })
    expect(removed.sort()).toEqual(['autoGroupMovement', 'tabGroups'])
  })
})

describe('runRetirement: tab groups', () => {
  it('removes the keys from the document and every overlay, with backups, once', () => {
    const first = runRetirement(RETIRED_TAB_GROUPS, paths.dir)
    expect(first.ran).toBe(true)
    expect(readSettings() as Record<string, unknown>).toEqual({ inboxAutoSettleDays: 3 })
    expect(listOverlays()[0]?.settings).toEqual({ preferredModel: 'm' })
    expect(existsSync(join(paths.dir, 'settings.json.pre-tab-groups.bak'))).toBe(true)
    expect(JSON.parse(readFileSync(join(paths.dir, 'settings.json.pre-tab-groups.bak'), 'utf8')).tabGroupMode).toBe('manual')
    expect(existsSync(join(paths.dir, RETIRED_TAB_GROUPS.marker))).toBe(true)
    expect(runRetirement(RETIRED_TAB_GROUPS, paths.dir).ran).toBe(false)
  })
})

describe('runRetiredSettingsMigrations', () => {
  it('runs each retirement under its own marker, so a later one still runs after an earlier one finished', () => {
    // The tab-group retirement already ran on this machine; the panel one has not.
    writeFileSync(join(paths.dir, RETIRED_TAB_GROUPS.marker), 'done\n')
    writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({ keepExplorerOnCollapse: true, thinkingEnabled: false, inboxAutoSettleDays: 3 }))

    runRetiredSettingsMigrations(paths.dir)

    expect(readSettings() as Record<string, unknown>).toEqual({ inboxAutoSettleDays: 3 })
    expect(existsSync(join(paths.dir, 'settings.json.pre-retired-panels.bak'))).toBe(true)
    expect(existsSync(join(paths.dir, RETIRED_PANEL_SETTINGS.marker))).toBe(true)
  })

  it('retires no key the settings registry still knows', async () => {
    const { settingScope } = await import('@ion/shared/settings-registry')
    const live = RETIRED_PANEL_SETTINGS.keys.concat(RETIRED_TAB_GROUPS.keys).filter((key) => settingScope(key) !== undefined)
    expect(live).toEqual([])
  })
})
