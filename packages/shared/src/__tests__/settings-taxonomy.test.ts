/**
 * The settings taxonomy: unique ids, pages grouped under their headings in
 * heading order, every section filed under a classified group, and every
 * placed key shown in a section that exists, under the group policy hides
 * that key by.
 */
import { describe, expect, it } from 'vitest'
import { settingPage } from '../settings-registry'
import { classifySettingsGroup } from '../settings-classification'
import {
  SERVERS_PAGE_ID, SETTINGS_KEY_PLACEMENT, SETTINGS_SCOPE_HEADINGS, SETTINGS_TAXONOMY, SETTINGS_TAXONOMY_PAGES,
  settingPlacement, taxonomyPage,
} from '../settings-taxonomy'

const sections = SETTINGS_TAXONOMY.flatMap((p) => p.sections)

/**
 * Keys whose registry group differs from the group of the section showing
 * them. Workspace folders are listed with the server's projects, whose page
 * policy hides as `environments`.
 */
const GROUP_EXCEPTIONS: Record<string, string> = { workspaceFolders: 'projects' }

describe('SETTINGS_TAXONOMY', () => {
  it('never repeats a page or section id', () => {
    for (const ids of [SETTINGS_TAXONOMY.map((p) => p.id), sections.map((s) => s.id)]) {
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('orders pages by heading, with the servers list first under Servers', () => {
    const order = SETTINGS_SCOPE_HEADINGS.map((h) => h.scope)
    const seen = SETTINGS_TAXONOMY.map((p) => order.indexOf(p.scope))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(SETTINGS_TAXONOMY.find((p) => p.scope === 'server')?.id).toBe(SERVERS_PAGE_ID)
    expect(SETTINGS_TAXONOMY_PAGES.some((p) => p.id === SERVERS_PAGE_ID)).toBe(false)
  })

  it('files every section under a classified settings group', () => {
    for (const s of sections) expect(classifySettingsGroup(s.group), s.id).toBeDefined()
  })
})

describe('SETTINGS_KEY_PLACEMENT', () => {
  it('places every key in a section of the page it names', () => {
    for (const [key, placement] of Object.entries(SETTINGS_KEY_PLACEMENT)) {
      const page = taxonomyPage(placement!.page)
      expect(page?.sections.some((s) => s.id === placement!.section), key).toBe(true)
    }
  })

  it('places every key under the group the registry names for it', () => {
    for (const [key, placement] of Object.entries(SETTINGS_KEY_PLACEMENT)) {
      const group = sections.find((s) => s.id === placement!.section)!.group
      expect(GROUP_EXCEPTIONS[key] ?? group, key).toBe(settingPage(key))
    }
  })

  it('answers nothing for a key on no page', () => {
    expect(settingPlacement('gitPanelHeight')).toBeUndefined()
    expect(settingPlacement('made-up')).toBeUndefined()
    expect(settingPlacement('soundEnabled')).toEqual({ page: 'behavior', section: 'device-behavior' })
  })
})
