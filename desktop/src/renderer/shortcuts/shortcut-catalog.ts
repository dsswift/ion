import { parseChord } from './chord'
import type { Chord } from './chord'
import type { ShortcutContext, ShortcutEntry, ShortcutResolution, ShortcutView } from './shortcut-types'
import { rWarn } from '../rendererLogger'

export type { ShortcutContext, ShortcutEntry, ShortcutGroup, ShortcutResolution, ShortcutView } from './shortcut-types'

export const SHORTCUT_GROUPS = [
  'Navigation',
  'Panels',
  'Layout',
  'Tabs',
  'Zoom',
  'Conversation',
  'App',
  'Studio',
] as const

/**
 * One registry for Overlay and Studio. IDs that existed in Overlay remain
 * stable because they are persisted in settings.json. A view-specific default
 * exists only when the two views genuinely perform different work.
 */
export const SHORTCUT_CATALOG: readonly ShortcutEntry[] = [
  { id: 'tab.prev', group: 'Navigation', description: 'Previous tab', defaultBinding: 'Mod+h', views: ['overlay', 'studio'] },
  { id: 'tab.next', group: 'Navigation', description: 'Next tab', defaultBinding: 'Mod+l', views: ['overlay', 'studio'] },
  { id: 'tab.close', group: 'Navigation', description: 'Close tab', defaultBinding: 'Mod+w', views: ['overlay', 'studio'] },

  { id: 'panel.inbox', group: 'Panels', description: 'Toggle inbox', defaultBinding: 'Mod+1', views: ['overlay', 'studio'] },
  { id: 'panel.explorer', group: 'Panels', description: 'Toggle file explorer', defaultBinding: 'Mod+2', views: ['overlay', 'studio'] },
  { id: 'panel.git', group: 'Panels', description: 'Toggle git panel', defaultBinding: 'Mod+3', views: ['overlay', 'studio'] },
  { id: 'panel.statusDrawer', group: 'Panels', description: 'Toggle status / right panel', defaultBinding: 'Mod+4', views: ['overlay', 'studio'] },

  { id: 'panel.editor', group: 'Panels', description: 'Toggle file editor', defaultBinding: 'Mod+e', views: ['overlay'] },
  { id: 'terminal.toggle', group: 'Panels', description: 'Toggle terminal (Ctrl)', defaultBinding: 'Ctrl+`', views: ['overlay', 'studio'] },
  { id: 'terminal.addShell', group: 'Panels', description: 'Add terminal shell instance', defaultBinding: 'Ctrl+Shift+`', views: ['overlay', 'studio'] },

  { id: 'layout.collapse', group: 'Layout', description: 'Collapse conversation', defaultBinding: 'Mod+j', views: ['overlay'] },
  { id: 'layout.tall', group: 'Layout', description: 'Toggle tall conversation', defaultBinding: 'Mod+y', views: ['overlay', 'studio'] },

  { id: 'tab.new', group: 'Tabs', description: 'New tab (default directory)', defaultBinding: 'Mod+t', views: ['overlay', 'studio'] },
  { id: 'tab.newHere', group: 'Tabs', description: 'New tab (current directory)', defaultBinding: 'Mod+Shift+t', views: ['overlay'] },
  { id: 'tab.recentDirs', group: 'Tabs', description: 'Open recent directories', defaultBinding: 'Mod+r', views: ['overlay', 'studio'] },
  { id: 'tab.scratch', group: 'Tabs', description: 'New scratch file', defaultBinding: 'Mod+n', views: ['overlay'] },

  { id: 'zoom.in', group: 'Zoom', description: 'Zoom in (active surface)', defaultBinding: 'Mod+=', views: ['overlay', 'studio'] },
  { id: 'zoom.inShifted', group: 'Zoom', description: 'Zoom in (shifted alias)', defaultBinding: 'Mod++', views: ['overlay', 'studio'] },
  { id: 'zoom.out', group: 'Zoom', description: 'Zoom out (active surface)', defaultBinding: 'Mod+-', views: ['overlay', 'studio'] },
  { id: 'zoom.reset', group: 'Zoom', description: 'Reset zoom (active surface)', defaultBinding: 'Mod+0', views: ['overlay', 'studio'] },

  { id: 'conversation.find', group: 'Conversation', description: 'Find in conversation', defaultBinding: 'Mod+f', views: ['overlay', 'studio'] },
  { id: 'conversation.findNext', group: 'Conversation', description: 'Find next', defaultBinding: 'Mod+g', views: ['overlay', 'studio'] },
  { id: 'conversation.findPrev', group: 'Conversation', description: 'Find previous', defaultBinding: 'Mod+Shift+g', views: ['overlay', 'studio'] },
  { id: 'permission.togglePlanAuto', group: 'Conversation', description: 'Toggle plan / auto mode', defaultBinding: 'Shift+Tab', views: ['overlay', 'studio'] },

  { id: 'app.commandPalette', group: 'App', description: 'Open command palette', defaultBinding: 'Mod+k', views: ['overlay', 'studio'] },
  { id: 'settings.open', group: 'App', description: 'Open settings', defaultBinding: 'Mod+,', views: ['overlay', 'studio'] },

  { id: 'studio.layout.sidebar', group: 'Studio', description: 'Toggle left sidebar', defaultBinding: 'Mod+b', views: ['studio'] },
  { id: 'studio.layout.surface', group: 'Studio', description: 'Toggle canvas panel', defaultBinding: 'Mod+Alt+b', views: ['studio'] },

  // Canvas tabs form one family: Mod+Alt+<digit>. Mod alone selects a REGION
  // (sidebar view, canvas visibility); adding Alt reaches INTO the canvas, the
  // same meaning Alt already carries in Mod+Alt+b. Mod+Shift+<digit> is not
  // available for this: macOS owns Mod+Shift+3 and Mod+Shift+4 as screenshot
  // shortcuts and consumes them before the renderer sees a keydown.
  { id: 'studio.surface.diff', group: 'Studio', description: 'Toggle diff canvas tab', defaultBinding: 'Mod+Alt+1', views: ['studio'] },
  { id: 'studio.surface.plan', group: 'Studio', description: 'Toggle plan canvas tab', defaultBinding: 'Mod+Alt+2', views: ['studio'] },
  { id: 'studio.surface.visualizer', group: 'Studio', description: 'Toggle visualizer canvas tab', defaultBinding: 'Mod+Alt+3', views: ['studio'] },
  { id: 'studio.surface.status', group: 'Studio', description: 'Toggle status canvas tab', defaultBinding: 'Mod+Alt+4', views: ['studio'] },
  { id: 'studio.surface.files', group: 'Studio', description: 'Toggle explorer canvas tab', defaultBinding: 'Mod+Alt+5', views: ['studio'] },
  { id: 'studio.surface.gitpanel', group: 'Studio', description: 'Toggle git canvas tab', defaultBinding: 'Mod+Alt+6', views: ['studio'] },
  { id: 'studio.surface.notification', group: 'Studio', description: 'Toggle notification canvas tab', defaultBinding: 'Mod+Alt+7', views: ['studio'] },

  { id: 'studio.tab.slot1', group: 'Studio', description: 'Select conversation 1', defaultBinding: 'Mod+Ctrl+1', views: ['studio'] },
  { id: 'studio.tab.slot2', group: 'Studio', description: 'Select conversation 2', defaultBinding: 'Mod+Ctrl+2', views: ['studio'] },
  { id: 'studio.tab.slot3', group: 'Studio', description: 'Select conversation 3', defaultBinding: 'Mod+Ctrl+3', views: ['studio'] },
  { id: 'studio.tab.slot4', group: 'Studio', description: 'Select conversation 4', defaultBinding: 'Mod+Ctrl+4', views: ['studio'] },
  { id: 'studio.tab.slot5', group: 'Studio', description: 'Select conversation 5', defaultBinding: 'Mod+Ctrl+5', views: ['studio'] },
  { id: 'studio.tab.slot6', group: 'Studio', description: 'Select conversation 6', defaultBinding: 'Mod+Ctrl+6', views: ['studio'] },
  { id: 'studio.tab.slot7', group: 'Studio', description: 'Select conversation 7', defaultBinding: 'Mod+Ctrl+7', views: ['studio'] },
  { id: 'studio.tab.slot8', group: 'Studio', description: 'Select conversation 8', defaultBinding: 'Mod+Ctrl+8', views: ['studio'] },
  { id: 'studio.tab.slot9', group: 'Studio', description: 'Select conversation 9', defaultBinding: 'Mod+Ctrl+9', views: ['studio'] },
]

export function getCatalogForView(view: ShortcutView): readonly ShortcutEntry[] {
  return SHORTCUT_CATALOG.filter((entry) => entry.views.includes(view))
}

export function defaultBinding(entry: ShortcutEntry, view: ShortcutView): string {
  return entry.viewDefaults?.[view] ?? entry.defaultBinding
}

function chordKey(binding: string): string | null {
  const chord = parseChord(binding)
  if (!chord) return null
  return [chord.mod ? 'Mod' : '', chord.ctrl ? 'Ctrl' : '', chord.shift ? 'Shift' : '', chord.alt ? 'Alt' : '', chord.key.toLowerCase()]
    .filter(Boolean)
    .join('+')
}

function contextsOverlap(a?: ShortcutContext, b?: ShortcutContext): boolean {
  return a === undefined || b === undefined || a === b
}

/**
 * Resolves one view's defaults and overrides. Every row survives in
 * `shortcuts`, including conflict losers, so Settings can truthfully display
 * configured input. `activeBindings` contains only deterministic winners.
 */
/**
 * Backward-compatible Overlay resolver. New callers use the view-aware
 * `resolveViewBindings`; legacy callers and existing tests still receive the
 * Map<commandId, Chord> contract during migration.
 */
export function resolveBindings(overrides: Record<string, string>): Map<string, Chord> {
  const resolution = resolveViewBindings('overlay', overrides)
  return new Map([...resolution.activeBindings].map(([id, shortcut]) => [id, parseChord(shortcut.binding)!]))
}

export function resolveViewBindings(view: ShortcutView, overrides: Record<string, string>): ShortcutResolution {
  const resolved: Array<{ entry: ShortcutEntry; binding: string; enabled: boolean; conflictsWith: string | null }> = getCatalogForView(view).map((entry) => {
    const requested = overrides[entry.id]
    const binding = requested && parseChord(requested) ? requested : defaultBinding(entry, view)
    return { entry, binding, enabled: true, conflictsWith: null }
  })

  for (let index = 0; index < resolved.length; index++) {
    const candidate = resolved[index]
    const key = chordKey(candidate.binding)
    if (!key) {
      candidate.enabled = false
      continue
    }
    for (let earlier = 0; earlier < index; earlier++) {
      const winner = resolved[earlier]
      if (!winner.enabled || !contextsOverlap(candidate.entry.when, winner.entry.when)) continue
      if (chordKey(winner.binding) !== key) continue
      candidate.enabled = false
      candidate.conflictsWith = winner.entry.id
      rWarn('shortcuts', 'binding conflict: earlier command wins', {
        view,
        chord: key,
        winner: winner.entry.id,
        loser: candidate.entry.id,
      })
      break
    }
  }

  const activeBindings = new Map<string, typeof resolved[number]>()
  for (const shortcut of resolved) {
    if (shortcut.enabled) activeBindings.set(shortcut.entry.id, shortcut)
  }
  return { shortcuts: resolved, activeBindings }
}

/** Alias retained for transition callers. */
export function resolveOverlayBindings(overrides: Record<string, string>): Map<string, Chord> {
  return resolveBindings(overrides)
}

export function getCatalogByGroup(view: ShortcutView): Map<string, readonly ShortcutEntry[]> {
  const result = new Map<string, readonly ShortcutEntry[]>()
  for (const group of SHORTCUT_GROUPS) {
    const entries = getCatalogForView(view).filter((entry) => entry.group === group)
    if (entries.length > 0) result.set(group, entries)
  }
  return result
}
