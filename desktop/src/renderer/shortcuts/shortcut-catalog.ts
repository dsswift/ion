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
 * The one shortcut registry (spec 17: Studio is the only conversation UI).
 * IDs remain stable because they are persisted in settings.json.
 */
export const SHORTCUT_CATALOG: readonly ShortcutEntry[] = [
  { id: 'tab.prev', group: 'Navigation', description: 'Previous tab', defaultBinding: 'Mod+h' },
  { id: 'tab.next', group: 'Navigation', description: 'Next tab', defaultBinding: 'Mod+l' },
  { id: 'tab.close', group: 'Navigation', description: 'Close tab', defaultBinding: 'Mod+w' },

  { id: 'panel.inbox', group: 'Panels', description: 'Toggle inbox', defaultBinding: 'Mod+1' },
  { id: 'panel.explorer', group: 'Panels', description: 'Toggle file explorer', defaultBinding: 'Mod+2' },
  { id: 'panel.git', group: 'Panels', description: 'Toggle git panel', defaultBinding: 'Mod+3' },
  { id: 'panel.search', group: 'Panels', description: 'Search all workspace files', defaultBinding: 'Mod+Shift+f' },
  { id: 'panel.statusDrawer', group: 'Panels', description: 'Toggle status / right panel', defaultBinding: 'Mod+4' },

  { id: 'terminal.toggle', group: 'Panels', description: 'Toggle terminal (Ctrl)', defaultBinding: 'Ctrl+`' },
  { id: 'terminal.addShell', group: 'Panels', description: 'Add terminal shell instance', defaultBinding: 'Ctrl+Shift+`' },

  { id: 'layout.tall', group: 'Layout', description: 'Toggle tall conversation', defaultBinding: 'Mod+y' },

  { id: 'tab.new', group: 'Tabs', description: 'New tab', defaultBinding: 'Mod+t' },
  { id: 'tab.newPicker', group: 'Tabs', description: 'New tab (choose conversation type)', defaultBinding: 'Mod+Alt+t' },
  { id: 'tab.newHere', group: 'Tabs', description: 'New tab (current directory)', defaultBinding: 'Mod+Shift+t' },
  { id: 'tab.recentDirs', group: 'Tabs', description: 'Open recent directories', defaultBinding: 'Mod+r' },
  { id: 'tab.scratch', group: 'Tabs', description: 'New Scratch Document', defaultBinding: 'Mod+n' },

  { id: 'zoom.in', group: 'Zoom', description: 'Zoom in (active surface)', defaultBinding: 'Mod+=' },
  { id: 'zoom.inShifted', group: 'Zoom', description: 'Zoom in (shifted alias)', defaultBinding: 'Mod++' },
  { id: 'zoom.out', group: 'Zoom', description: 'Zoom out (active surface)', defaultBinding: 'Mod+-' },
  { id: 'zoom.reset', group: 'Zoom', description: 'Reset zoom (active surface)', defaultBinding: 'Mod+0' },

  // Find follows focus: the canvas pane when it was clicked or focused last,
  // the conversation otherwise. The ids keep their persisted names.
  { id: 'conversation.find', group: 'Conversation', description: 'Find in focused pane', defaultBinding: 'Mod+f' },
  { id: 'conversation.findNext', group: 'Conversation', description: 'Find next', defaultBinding: 'Mod+g' },
  { id: 'conversation.findPrev', group: 'Conversation', description: 'Find previous', defaultBinding: 'Mod+Shift+g' },
  { id: 'permission.togglePlanAuto', group: 'Conversation', description: 'Toggle plan / auto mode', defaultBinding: 'Shift+Tab' },
  { id: 'composer.attach', group: 'Conversation', description: 'Attach file to prompt', defaultBinding: 'Mod+Alt+a' },
  { id: 'composer.screenshot', group: 'Conversation', description: 'Take screenshot for prompt', defaultBinding: 'Mod+Alt+s' },
  { id: 'composer.quickTools', group: 'Conversation', description: 'Open Quick Tools', defaultBinding: 'Mod+Alt+q' },

  { id: 'app.commandPalette', group: 'App', description: 'Open command palette', defaultBinding: 'Mod+k' },
  { id: 'settings.open', group: 'App', description: 'Open settings', defaultBinding: 'Mod+,' },

  { id: 'studio.layout.sidebar', group: 'Studio', description: 'Toggle left sidebar', defaultBinding: 'Mod+b' },
  { id: 'studio.layout.surface', group: 'Studio', description: 'Toggle canvas panel', defaultBinding: 'Mod+Alt+b' },
  { id: 'studio.layout.surfaceMaximize', group: 'Studio', description: 'Maximize canvas panel', defaultBinding: 'Mod+Alt+Shift+b' },

  // Canvas tabs form one family: Mod+Alt+<digit>. Mod alone selects a REGION
  // (sidebar view, canvas visibility); adding Alt reaches INTO the canvas, the
  // same meaning Alt already carries in Mod+Alt+b. Mod+Shift+<digit> is not
  // available for this: macOS owns Mod+Shift+3 and Mod+Shift+4 as screenshot
  // shortcuts and consumes them before the renderer sees a keydown.
  { id: 'studio.surface.diff', group: 'Studio', description: 'Toggle diff canvas tab', defaultBinding: 'Mod+Alt+1' },
  { id: 'studio.surface.plan', group: 'Studio', description: 'Toggle plan canvas tab', defaultBinding: 'Mod+Alt+2' },
  { id: 'studio.surface.visualizer', group: 'Studio', description: 'Toggle visualizer canvas tab', defaultBinding: 'Mod+Alt+3' },
  { id: 'studio.surface.status', group: 'Studio', description: 'Toggle status canvas tab', defaultBinding: 'Mod+Alt+4' },
  { id: 'studio.surface.files', group: 'Studio', description: 'Toggle explorer canvas tab', defaultBinding: 'Mod+Alt+5' },
  { id: 'studio.surface.gitpanel', group: 'Studio', description: 'Toggle git canvas tab', defaultBinding: 'Mod+Alt+6' },
  { id: 'studio.surface.graph', group: 'Studio', description: 'Toggle graph canvas tab', defaultBinding: 'Mod+Alt+8' },
  { id: 'studio.surface.notification', group: 'Studio', description: 'Toggle notification canvas tab', defaultBinding: 'Mod+Alt+7' },
  { id: 'studio.surface.ports', group: 'Studio', description: 'Toggle ports canvas tab', defaultBinding: 'Mod+Alt+9' },

  { id: 'studio.tab.slot1', group: 'Studio', description: 'Select conversation 1', defaultBinding: 'Mod+Ctrl+1' },
  { id: 'studio.tab.slot2', group: 'Studio', description: 'Select conversation 2', defaultBinding: 'Mod+Ctrl+2' },
  { id: 'studio.tab.slot3', group: 'Studio', description: 'Select conversation 3', defaultBinding: 'Mod+Ctrl+3' },
  { id: 'studio.tab.slot4', group: 'Studio', description: 'Select conversation 4', defaultBinding: 'Mod+Ctrl+4' },
  { id: 'studio.tab.slot5', group: 'Studio', description: 'Select conversation 5', defaultBinding: 'Mod+Ctrl+5' },
  { id: 'studio.tab.slot6', group: 'Studio', description: 'Select conversation 6', defaultBinding: 'Mod+Ctrl+6' },
  { id: 'studio.tab.slot7', group: 'Studio', description: 'Select conversation 7', defaultBinding: 'Mod+Ctrl+7' },
  { id: 'studio.tab.slot8', group: 'Studio', description: 'Select conversation 8', defaultBinding: 'Mod+Ctrl+8' },
  { id: 'studio.tab.slot9', group: 'Studio', description: 'Select conversation 9', defaultBinding: 'Mod+Ctrl+9' },
]

/** Every entry applies to the one view now; retained for the persisted per-view override shape. */
export function getCatalogForView(_view: ShortcutView): readonly ShortcutEntry[] {
  return SHORTCUT_CATALOG
}

export function defaultBinding(entry: ShortcutEntry): string {
  return entry.defaultBinding
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
 * Single-view convenience wrapper returning the plain Map<commandId, Chord>
 * contract; production code calls the view-aware `resolveViewBindings`
 * directly.
 */
export function resolveBindings(overrides: Record<string, string>): Map<string, Chord> {
  const resolution = resolveViewBindings('studio', overrides)
  return new Map([...resolution.activeBindings].map(([id, shortcut]) => [id, parseChord(shortcut.binding)!]))
}

export function resolveViewBindings(view: ShortcutView, overrides: Record<string, string>): ShortcutResolution {
  const resolved: Array<{ entry: ShortcutEntry; binding: string; enabled: boolean; conflictsWith: string | null }> = getCatalogForView(view).map((entry) => {
    const requested = overrides[entry.id]
    const binding = requested && parseChord(requested) ? requested : defaultBinding(entry)
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

export function getCatalogByGroup(view: ShortcutView): Map<string, readonly ShortcutEntry[]> {
  const result = new Map<string, readonly ShortcutEntry[]>()
  for (const group of SHORTCUT_GROUPS) {
    const entries = getCatalogForView(view).filter((entry) => entry.group === group)
    if (entries.length > 0) result.set(group, entries)
  }
  return result
}
