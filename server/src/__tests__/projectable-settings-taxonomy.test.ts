/**
 * The phone lays the projected settings out on the pages and sections Studio
 * shows them on. Both are checked against one source,
 * `SETTINGS_KEY_PLACEMENT` in `@ion/shared/settings-taxonomy`: the Studio
 * catalog's test holds its search items to it, and this test holds the
 * projection to it, so a key is never on one page in Studio and another on
 * the phone.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/effective-settings', () => ({ readEffectiveSettings: () => ({}) }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { SETTINGS_KEY_PLACEMENT, SETTINGS_TAXONOMY } from '@ion/shared/settings-taxonomy'
import type { SettingKey } from '@ion/shared/settings-registry'
import { PROJECTABLE_SETTINGS, projectablePages, projectableSchema } from '../projectable-settings'

describe('projected settings and the settings taxonomy', () => {
  it('names, for every projected key, the section Studio shows it in', () => {
    // tabRecoveryEnabled and defaultEngineProfileId have no Studio row; the
    // taxonomy places them in their group's section (Inbox, Default models).
    const drift = PROJECTABLE_SETTINGS
      .filter((s) => {
        const placed = SETTINGS_KEY_PLACEMENT[s.key as SettingKey]
        return placed?.page !== s.page || placed?.section !== s.section
      })
      .map((s) => `${s.key}: projected=${s.page}/${s.section} placed=${JSON.stringify(SETTINGS_KEY_PLACEMENT[s.key as SettingKey])}`)
    expect(drift).toEqual([])
  })

  it('carries the page and section on every schema entry', () => {
    for (const entry of projectableSchema()) {
      expect(SETTINGS_KEY_PLACEMENT[entry.key as SettingKey], entry.key).toEqual({ page: entry.page, section: entry.section })
    }
  })

  it('lists every page with a projected key and every server page but Fleet, in Studio order, with all their sections', () => {
    const pages = projectablePages()
    const withKeys = new Set(projectableSchema().map((e) => e.page))
    const expected = SETTINGS_TAXONOMY.filter((p) => p.id !== 'servers' && (p.scope === 'server' || withKeys.has(p.id)))
    expect(pages.map((p) => p.id)).toEqual(expected.map((p) => p.id))
    expect(pages.find((p) => p.id === 'defaults')).toEqual({
      id: 'defaults', label: 'Defaults', scope: 'you',
      sections: [{ id: 'defaults-conversation', label: 'New conversations' }, { id: 'defaults-thinking', label: 'Extended thinking' }],
    })
    // A page whose keys are all Studio-only, and a page with no projected
    // key, are left out. Fleet lists every paired server, so a client
    // would show it as one server's page with an empty Servers section.
    expect(pages.map((p) => p.id)).not.toContain('appearance')
    expect(pages.map((p) => p.id)).not.toContain('keyboard')
    expect(pages.map((p) => p.id)).not.toContain('servers')
    expect(pages.map((p) => p.id)).toContain('health')
    expect(pages.find((p) => p.id === 'integrations')?.sections.map((s) => s.id)).toEqual(['mcp', 'automation', 'entra'])
  })
})
