import * as shortcutCatalog from './shortcuts/shortcut-catalog'
import { defaultBinding } from './shortcuts/shortcut-catalog'
import { parseChord } from './shortcuts/chord'
import { rInfo, rWarn } from './rendererLogger'
import type { PreferencesState } from './preferences-types'
import type { ShortcutEntry, ShortcutGroup, ShortcutResolution } from './shortcuts/shortcut-types'

export type ShortcutView = 'overlay' | 'studio'
export type KeyboardShortcuts = Record<ShortcutView, Record<string, string>>

const VIEWS: readonly ShortcutView[] = ['overlay', 'studio']

interface ViewCatalogApi {
  getCatalogForView?: (view: ShortcutView) => readonly ShortcutEntry[]
  getGroupsForView?: (view: ShortcutView) => readonly ShortcutGroup[]
  resolveViewBindings?: (view: ShortcutView, overrides: Record<string, string>) => ShortcutResolution
}

const viewCatalog = shortcutCatalog as typeof shortcutCatalog & ViewCatalogApi

export const EMPTY_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  overlay: {},
  studio: {},
}

export function getCatalogForView(view: ShortcutView): readonly ShortcutEntry[] {
  return viewCatalog.getCatalogForView?.(view) ?? shortcutCatalog.SHORTCUT_CATALOG
}

export function getGroupsForView(view: ShortcutView): readonly ShortcutGroup[] {
  return viewCatalog.getGroupsForView?.(view) ?? shortcutCatalog.SHORTCUT_GROUPS
}

export function resolveViewBindings(view: ShortcutView, overrides: Record<string, string>): ShortcutResolution {
  return viewCatalog.resolveViewBindings?.(view, overrides) ?? {
    shortcuts: [],
    activeBindings: new Map(),
  }
}

/**
 * Load only valid per-view override maps. Legacy flat overrides belong to the
 * overlay, preserving existing bindings after upgrade.
 */
export function sanitizeKeyboardShortcuts(value: unknown): KeyboardShortcuts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { overlay: {}, studio: {} }
  const raw = value as Record<string, unknown>
  const hasViews = VIEWS.some((view) => raw[view] && typeof raw[view] === 'object' && !Array.isArray(raw[view]))
  if (!hasViews) return { overlay: sanitizeOverrides(raw), studio: {} }
  return {
    overlay: sanitizeOverrides(raw.overlay),
    studio: sanitizeOverrides(raw.studio),
  }
}

export function createKeyboardShortcutActions(
  set: (patch: Partial<PreferencesState>) => void,
  get: () => PreferencesState,
  save: () => void,
) {
  return {
    setKeyboardShortcut: (view: ShortcutView, commandId: string, chord: string) => {
      if (!parseChord(chord)) {
        rWarn('preferences', 'setKeyboardShortcut rejected invalid chord', { chord, command_id: commandId, view })
        return
      }
      const entry = getCatalogForView(view).find((candidate) => candidate.id === commandId)
      if (!entry) {
        rWarn('preferences', 'setKeyboardShortcut rejected unknown command id', { command_id: commandId, view })
        return
      }
      const overrides = { ...get().keyboardShortcuts[view] }
      if (chord === defaultBinding(entry, view)) delete overrides[commandId]
      else overrides[commandId] = chord
      set({ keyboardShortcuts: { ...get().keyboardShortcuts, [view]: overrides } })
      rInfo('preferences', 'keyboard shortcut override updated', { command_id: commandId, view, customized: chord !== defaultBinding(entry, view) })
      save()
    },
    resetKeyboardShortcut: (view: ShortcutView, commandId: string) => {
      const overrides = { ...get().keyboardShortcuts[view] }
      delete overrides[commandId]
      set({ keyboardShortcuts: { ...get().keyboardShortcuts, [view]: overrides } })
      rInfo('preferences', 'keyboard shortcut override reset', { command_id: commandId, view })
      save()
    },
    resetKeyboardShortcuts: (view: ShortcutView) => {
      set({ keyboardShortcuts: { ...get().keyboardShortcuts, [view]: {} } })
      rInfo('preferences', 'keyboard shortcuts reset for view', { view })
      save()
    },
    resetAllKeyboardShortcuts: () => {
      set({ keyboardShortcuts: { overlay: {}, studio: {} } })
      rInfo('preferences', 'keyboard shortcuts reset for all views')
      save()
    },
  }
}

function sanitizeOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] =>
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string' &&
        parseChord(entry[1]) !== null,
      ),
  )
}
