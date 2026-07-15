/**
 * Shortcut catalog — single source of truth for every keyboard shortcut
 * command in the desktop app.
 *
 * Each entry has:
 *   - `id`: stable command identifier persisted in settings.json as the key
 *     of the override map. Treat as a contract — renaming is a migration.
 *   - `group`: display group (mirrors the handler's logical sections).
 *   - `description`: human-readable label shown in the Settings UI.
 *   - `defaultBinding`: normalized chord string (Mod = Cmd on mac / Ctrl elsewhere).
 *
 * `resolveBindings(overrides)` merges defaults with user overrides from
 * settings.json, producing the Map that both the keydown handler and the
 * Settings UI consume. The handler must use this Map — a separate hardcoded
 * list would be the forbidden "document but hardcode" anti-pattern.
 */

import { parseChord } from './chord'
import type { Chord } from './chord'
import { rWarn } from '../rendererLogger'

export interface ShortcutEntry {
  id: string
  group: ShortcutGroup
  description: string
  defaultBinding: string
}

export type ShortcutGroup =
  | 'Navigation'
  | 'Panels'
  | 'Layout'
  | 'Tabs'
  | 'Zoom'
  | 'Conversation'
  | 'App'

/** All shortcut groups in display order. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  'Navigation',
  'Panels',
  'Layout',
  'Tabs',
  'Zoom',
  'Conversation',
  'App',
]

/**
 * The full catalog. Order within each group determines the deterministic
 * conflict-winner (first in catalog order wins when two commands share a chord).
 */
export const SHORTCUT_CATALOG: ShortcutEntry[] = [
  // Navigation
  { id: 'tab.prev',          group: 'Navigation',   description: 'Previous tab',               defaultBinding: 'Mod+h' },
  { id: 'tab.next',          group: 'Navigation',   description: 'Next tab',                   defaultBinding: 'Mod+l' },
  { id: 'tab.close',         group: 'Navigation',   description: 'Close tab',                  defaultBinding: 'Mod+w' },

  // Panels
  { id: 'panel.explorer',    group: 'Panels',       description: 'Toggle file explorer',        defaultBinding: 'Mod+1' },
  { id: 'panel.terminal',    group: 'Panels',       description: 'Toggle terminal',             defaultBinding: 'Mod+2' },
  { id: 'panel.git',         group: 'Panels',       description: 'Toggle git panel',            defaultBinding: 'Mod+3' },
  { id: 'panel.editor',      group: 'Panels',       description: 'Toggle file editor',          defaultBinding: 'Mod+e' },
  { id: 'terminal.toggle',   group: 'Panels',       description: 'Toggle terminal (Ctrl)',       defaultBinding: 'Ctrl+`' },
  { id: 'terminal.addShell', group: 'Panels',       description: 'Add terminal shell instance', defaultBinding: 'Ctrl+Shift+`' },

  // Layout
  { id: 'layout.collapse',   group: 'Layout',       description: 'Collapse conversation',       defaultBinding: 'Mod+j' },
  { id: 'layout.expand',     group: 'Layout',       description: 'Expand conversation',         defaultBinding: 'Mod+k' },
  { id: 'layout.tall',       group: 'Layout',       description: 'Toggle tall view',            defaultBinding: 'Mod+y' },

  // Tabs
  { id: 'tab.new',           group: 'Tabs',         description: 'New tab (default dir)',        defaultBinding: 'Mod+t' },
  { id: 'tab.newHere',       group: 'Tabs',         description: 'New tab (current dir)',        defaultBinding: 'Mod+Shift+t' },
  { id: 'tab.recentDirs',    group: 'Tabs',         description: 'Open recent directories',     defaultBinding: 'Mod+r' },
  { id: 'tab.scratch',       group: 'Tabs',         description: 'New scratch file',            defaultBinding: 'Mod+n' },

  // Zoom
  // zoom.inShifted is the shifted-'=' alias (Mod++) for zoom in. It lives in
  // the catalog so user overrides to zoom.in stay consistent with the alias,
  // and so the alias itself is independently rebindable.
  { id: 'zoom.in',           group: 'Zoom',         description: 'Zoom in (active surface)',         defaultBinding: 'Mod+=' },
  { id: 'zoom.inShifted',    group: 'Zoom',         description: 'Zoom in — shifted alias (Mod++)',  defaultBinding: 'Mod++' },
  { id: 'zoom.out',          group: 'Zoom',         description: 'Zoom out (active surface)',        defaultBinding: 'Mod+-' },
  { id: 'zoom.reset',        group: 'Zoom',         description: 'Reset zoom (active surface)',      defaultBinding: 'Mod+0' },

  // Conversation
  { id: 'conversation.find',           group: 'Conversation', description: 'Find in conversation',       defaultBinding: 'Mod+f' },
  { id: 'conversation.findNext',       group: 'Conversation', description: 'Find next',                  defaultBinding: 'Mod+g' },
  { id: 'conversation.findPrev',       group: 'Conversation', description: 'Find previous',              defaultBinding: 'Mod+Shift+g' },
  { id: 'permission.togglePlanAuto',   group: 'Conversation', description: 'Toggle plan / auto mode',    defaultBinding: 'Shift+Tab' },

  // App
  { id: 'settings.open',     group: 'App',          description: 'Open settings',               defaultBinding: 'Mod+,' },
]

/**
 * Build a resolved binding map from the catalog defaults merged with user
 * overrides from settings.json.
 *
 * - Overrides whose chord fails `parseChord` are silently dropped (tolerant
 *   load: a malformed external edit doesn't crash the handler).
 * - Overrides for unknown command ids are silently ignored (forward-compat:
 *   a settings file from a newer version doesn't crash an older desktop).
 * - When two resolved commands share a chord the first-in-catalog-order
 *   entry wins. The handler calls this once on mount; re-call when overrides
 *   change.
 *
 * Returns a Map<commandId, Chord> ready for `matchesChord`.
 */
export function resolveBindings(overrides: Record<string, string>): Map<string, Chord> {
  const _knownIds = new Set(SHORTCUT_CATALOG.map((e) => e.id))
  const result = new Map<string, Chord>()

  for (const entry of SHORTCUT_CATALOG) {
    const overrideStr = overrides[entry.id]
    // If there's a valid override for this id, use it; otherwise use default.
    if (overrideStr !== undefined) {
      const parsed = parseChord(overrideStr)
      if (parsed) {
        result.set(entry.id, parsed)
        continue
      }
      // Invalid override — fall through to default.
    }
    const defaultParsed = parseChord(entry.defaultBinding)
    if (defaultParsed) {
      result.set(entry.id, defaultParsed)
    }
  }

  // Detect conflicts: log a warning when two commands resolve to the same chord.
  // First-in-catalog-order wins (already set above); we only log here.
  const seenChords = new Map<string, string>() // chordKey -> commandId
  for (const entry of SHORTCUT_CATALOG) {
    if (!result.has(entry.id)) continue
    const chord = result.get(entry.id)!
    const chordKey = chordToKey(chord)
    const existing = seenChords.get(chordKey)
    if (existing) {
      rWarn('shortcuts', 'chord conflict: existing wins', { later_id: entry.id, existing_id: existing, chord: chordKey })
      // Remove the later entry (entry.id) — existing wins.
      result.delete(entry.id)
    } else {
      seenChords.set(chordKey, entry.id)
    }
  }

  return result
}

/** Serialize a Chord to a stable string key for conflict detection.
 *  Mod and Ctrl are kept as distinct literal strings, so a Mod+X entry and a
 *  Ctrl+X entry never collide in the key space. The current catalog has no
 *  entry that sets both mod and ctrl simultaneously, and the two Ctrl-only
 *  entries (terminal.toggle, terminal.addShell) use ` which no Mod+ entry
 *  uses — no normalization to a platform-effective modifier is needed. */
function chordToKey(c: Chord): string {
  return [c.mod ? 'Mod' : '', c.ctrl ? 'Ctrl' : '', c.shift ? 'Shift' : '', c.alt ? 'Alt' : '', c.key]
    .filter(Boolean)
    .join('+')
}

/**
 * Returns the command ids grouped for display, preserving SHORTCUT_GROUPS order.
 */
export function getCatalogByGroup(): Map<ShortcutGroup, ShortcutEntry[]> {
  const map = new Map<ShortcutGroup, ShortcutEntry[]>()
  for (const group of SHORTCUT_GROUPS) {
    map.set(group, [])
  }
  for (const entry of SHORTCUT_CATALOG) {
    map.get(entry.group)!.push(entry)
  }
  return map
}
