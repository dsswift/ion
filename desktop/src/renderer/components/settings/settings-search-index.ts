/**
 * settings-search-index — finds individual settings, not pages.
 *
 * The index IS the catalog: every item a page declares is searchable, so a
 * setting added to a page is findable with no second list to keep in step.
 * A query matches an item when every word of it appears in the item's
 * label, keywords, or page and section names.
 */
import type { SettingsItem, SettingsPage, SettingsSection } from './settings-catalog'

export interface SettingsSearchHit {
  page: SettingsPage
  section: SettingsSection
  item: SettingsItem
}

export function searchSettings(query: string, pages: readonly SettingsPage[], sectionsOf: (page: SettingsPage) => readonly SettingsSection[]): SettingsSearchHit[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const hits: SettingsSearchHit[] = []
  for (const page of pages) {
    for (const section of sectionsOf(page)) {
      for (const item of section.items) {
        const haystack = `${item.label} ${item.keywords} ${page.label}`.toLowerCase()
        if (terms.every((t) => haystack.includes(t))) hits.push({ page, section, item })
      }
    }
  }
  return hits
}
