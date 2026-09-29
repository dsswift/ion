// @vitest-environment jsdom
/**
 * settings-catalog — the pages under their headings, every classified group
 * filed somewhere (so hiding it hides something real), every setting with a
 * page findable by search, and old tab ids still landing on the right page.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../host/host-instance', () => ({ host: { capabilities: () => ['local'], onFrame: () => () => {}, deviceSettings: async () => ({}), setDeviceSetting: async () => {} }, action: vi.fn() }))

import { SETTINGS_REGISTRY, isServerWrittenSettingKey, type SettingKey } from '@ion/shared/settings-registry'
import { SETTINGS_GROUP_CLASSIFICATIONS } from '@ion/shared/settings-classification'
import { SETTINGS_KEY_PLACEMENT, SETTINGS_TAXONOMY_PAGES, SETTINGS_TAXONOMY_SERVERS_PAGE } from '@ion/shared/settings-taxonomy'
import { SETTINGS_PAGES, SERVERS_PAGE, SETTINGS_SCOPE_HEADINGS, resolveSettingsTab, visiblePages, visibleSections } from '../settings-catalog'
import { searchSettings } from '../settings-search-index'

const ALL_PAGES = [...SETTINGS_PAGES, SERVERS_PAGE]
const sections = ALL_PAGES.flatMap((p) => p.sections)
const items = sections.flatMap((s) => s.items)

/** Settings with a page but nothing to show: internal state the app keeps for itself. */
const NO_SETTINGS_UI: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'tabRecoveryEnabled', 'tabRecoveryTimeoutSec', // recovery tuning, read by the server only
  'projectSettingsVersion', // migration marker
  'defaultBaseDirectory', 'recentBaseDirectories', 'directoryUsageCounts', // remembered by the directory picker
  'defaultEngineProfileId', // set from the phone's projected settings; the desktop picks a profile per project
])

describe('SETTINGS_PAGES', () => {
  it('lists pages under their heading, in heading order', () => {
    const order = SETTINGS_SCOPE_HEADINGS.map((h) => h.scope)
    const seen = SETTINGS_PAGES.map((p) => order.indexOf(p.scope))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(SETTINGS_PAGES.filter((p) => p.scope === 'server').map((p) => p.id)).toEqual([
      'overview', 'projects', 'git-access', 'models', 'agent', 'integrations', 'workflow', 'access', 'health',
    ])
  })

  it('files every classified settings group under a section, except projects which rides the environment pages', () => {
    const groups = new Set(sections.map((s) => s.group))
    for (const group of SETTINGS_GROUP_CLASSIFICATIONS) {
      if (group.id === 'projects') continue
      expect(groups.has(group.id), group.id).toBe(true)
    }
    for (const s of sections) expect(SETTINGS_GROUP_CLASSIFICATIONS.some((g) => g.id === s.group), s.id).toBe(true)
  })

  it('never repeats a page, section, or item id', () => {
    for (const ids of [ALL_PAGES.map((p) => p.id), sections.map((s) => s.id), items.map((i) => i.id)]) {
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('makes every setting with a page findable, or names why it has no UI', () => {
    const shown = new Set(items.flatMap((i) => i.keys ?? []))
    for (const [key, entry] of Object.entries(SETTINGS_REGISTRY) as Array<[SettingKey, { page: string }]>) {
      if (entry.page === 'none' || isServerWrittenSettingKey(key) || NO_SETTINGS_UI.has(key)) continue
      expect(shown.has(key), key).toBe(true)
    }
    for (const key of NO_SETTINGS_UI) expect(shown.has(key), `${key} is shown; drop it from NO_SETTINGS_UI`).toBe(false)
  })
})

describe('the catalog and the shared settings taxonomy', () => {
  const facts = (p: { id: string; label: string; scope: string; description?: string; sections: readonly { id: string; label: string; group: string }[] }) => ({
    id: p.id, label: p.label, scope: p.scope, description: p.description,
    sections: p.sections.map((s) => ({ id: s.id, label: s.label, group: s.group })),
  })

  it('has exactly the taxonomy pages and sections, in the same order, with the same labels and groups', () => {
    expect(SETTINGS_PAGES.map(facts)).toEqual(SETTINGS_TAXONOMY_PAGES.map(facts))
    expect(facts(SERVERS_PAGE)).toEqual(facts(SETTINGS_TAXONOMY_SERVERS_PAGE))
  })

  it('shows every key in the section the taxonomy places it in', () => {
    const shownAt = new Map<string, string>()
    for (const page of ALL_PAGES) {
      for (const section of page.sections) {
        for (const key of section.items.flatMap((i) => i.keys ?? [])) shownAt.set(key, `${page.id}/${section.id}`)
      }
    }
    for (const [key, at] of shownAt) {
      const placed = SETTINGS_KEY_PLACEMENT[key as SettingKey]
      expect(placed && `${placed.page}/${placed.section}`, key).toBe(at)
    }
  })

  it('places a key with no row only when it is one of the settings with no UI', () => {
    // tabRecoveryEnabled and defaultEngineProfileId are sent to the phone, so
    // the taxonomy places them in the section of their group (Inbox and
    // Default models) even though Studio shows no row for them.
    const shown = new Set(items.flatMap((i) => i.keys ?? []))
    const placedWithoutRow = (Object.keys(SETTINGS_KEY_PLACEMENT) as SettingKey[]).filter((key) => !shown.has(key))
    expect(placedWithoutRow.sort()).toEqual(['defaultEngineProfileId', 'tabRecoveryEnabled'])
    for (const key of placedWithoutRow) expect(NO_SETTINGS_UI.has(key), key).toBe(true)
  })
})

describe('resolveSettingsTab', () => {
  it('maps page ids, section ids, and legacy names onto a location', () => {
    expect(resolveSettingsTab('appearance', 'env-a')).toEqual({ pageId: 'appearance', environmentId: null, anchor: null })
    expect(resolveSettingsTab('quicktools', 'env-a')).toEqual({ pageId: 'workflow', environmentId: 'env-a', anchor: 'quicktools' })
    expect(resolveSettingsTab('mcp', 'env-a')).toEqual({ pageId: 'integrations', environmentId: 'env-a', anchor: 'mcp' })
    expect(resolveSettingsTab('shortcuts', 'env-a')).toEqual({ pageId: 'keyboard', environmentId: null, anchor: null })
    expect(resolveSettingsTab('ai', 'env-a')).toEqual({ pageId: 'models', environmentId: 'env-a', anchor: 'ai' })
    expect(resolveSettingsTab('environments', 'env-a')).toEqual({ pageId: 'servers', environmentId: null, anchor: null })
    expect(resolveSettingsTab('projects', 'env-a')).toEqual({ pageId: 'projects', environmentId: 'env-a', anchor: null })
    expect(resolveSettingsTab('git-identity', 'env-a')).toEqual({ pageId: 'git-access', environmentId: 'env-a', anchor: null })
    expect(resolveSettingsTab('general', 'env-a')).toEqual({ pageId: 'defaults', environmentId: null, anchor: null })
    expect(resolveSettingsTab('presets', 'env-a')).toEqual({ pageId: 'advanced', environmentId: null, anchor: 'presets' })
  })
  it('opens phone and relay on the server asked for', () => {
    expect(resolveSettingsTab('remote', 'env-a')).toEqual({ pageId: 'access', environmentId: 'env-a', anchor: 'remote' })
  })
  it('falls back to the first page for nothing or an unknown id', () => {
    expect(resolveSettingsTab(undefined, 'env-a')).toEqual({ pageId: 'appearance', environmentId: null, anchor: null })
    expect(resolveSettingsTab('made-up', 'env-a')).toEqual({ pageId: 'appearance', environmentId: null, anchor: null })
  })
})

describe('visibleSections', () => {
  const page = (id: string) => SETTINGS_PAGES.find((p) => p.id === id)!
  it('drops sections whose group policy hides, and pages left empty', () => {
    const filter = { hiddenGroups: ['mcp', 'automation', 'entra'], capabilities: ['local' as const] }
    expect(visibleSections(page('integrations'), filter)).toEqual([])
    expect(visiblePages(SETTINGS_PAGES, 'server', filter).map((p) => p.id)).not.toContain('integrations')
  })
  it('keeps only bridged sections on a host without the local capability', () => {
    const filter = { hiddenGroups: [], capabilities: [] }
    expect(visibleSections(page('models'), filter).map((s) => s.id)).toEqual(['ai'])
    expect(visiblePages(SETTINGS_PAGES, 'server', filter).map((p) => p.id)).toEqual(['models', 'agent', 'integrations', 'workflow'])
  })
  it('shows phone and relay beside devices and discovery for every server', () => {
    expect(visibleSections(page('access'), { hiddenGroups: [], capabilities: ['local'] }).map((s) => s.id)).toEqual(['devices', 'discovery', 'remote'])
  })
})

describe('searchSettings', () => {
  const all = (p: (typeof ALL_PAGES)[number]) => p.sections
  it('finds individual settings by any word of their label or keywords', () => {
    expect(searchSettings('word wrap', ALL_PAGES, all).map((h) => h.item.id)).toEqual(['word-wrap'])
    expect(searchSettings('allowlist', ALL_PAGES, all).map((h) => `${h.page.id}/${h.item.id}`)).toEqual(['agent/plan-bash'])
    expect(searchSettings('relay', ALL_PAGES, all).map((h) => h.section.id)).toContain('remote')
  })
  it('never finds a section the filter hides', () => {
    const noRemote = (p: (typeof ALL_PAGES)[number]) => visibleSections(p, { hiddenGroups: ['remote'], capabilities: ['local'] })
    expect(searchSettings('relay server', ALL_PAGES, noRemote)).toEqual([])
  })
  it('finds nothing for an empty query', () => {
    expect(searchSettings('   ', ALL_PAGES, all)).toEqual([])
  })
})
