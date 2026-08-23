import { useMemo } from 'react'
import { usePreferencesStore } from '../../preferences'
import { getCatalogForView, getGroupsForView, resolveViewBindings } from '../../preferences-shortcuts'
import type { ShortcutView } from '../../preferences-shortcuts'
import { ShortcutColumn } from './ShortcutColumn'

const VIEWS: readonly { view: ShortcutView; label: string }[] = [
  { view: 'overlay', label: 'Overlay' },
  { view: 'studio', label: 'Studio' },
]

export function KeyboardShortcutsCategory() {
  const keyboardShortcuts = usePreferencesStore((state) => state.keyboardShortcuts)
  const setKeyboardShortcut = usePreferencesStore((state) => state.setKeyboardShortcut)
  const resetKeyboardShortcut = usePreferencesStore((state) => state.resetKeyboardShortcut)
  const resetAllKeyboardShortcuts = usePreferencesStore((state) => state.resetAllKeyboardShortcuts)

  const columns = useMemo(() => VIEWS.map(({ view, label }) => {
    const entries = getCatalogForView(view)
    const resolution = resolveViewBindings(view, keyboardShortcuts[view])
    const bindings = new Map(resolution.shortcuts.map((shortcut) => [shortcut.entry.id, shortcut.binding]))
    const conflicts = new Map(resolution.shortcuts.flatMap((shortcut) => shortcut.conflictsWith ? [[shortcut.entry.id, shortcut.conflictsWith] as const] : []))
    return { view, label, entries, bindings, conflicts }
  }), [keyboardShortcuts])

  const hasCustomizations = Object.values(keyboardShortcuts).some((overrides) => Object.keys(overrides).length > 0)

  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
      <p style={{ margin: 0, fontSize: 12 }}>
        Shortcut customizations persist separately for Overlay and Studio in <code>~/.ion/settings.json</code>.
      </p>
      {hasCustomizations && <button onClick={resetAllKeyboardShortcuts}>Restore all defaults</button>}
    </div>
    <div data-testid="shortcut-columns" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 24, alignItems: 'start', minWidth: 0 }}>
      {columns.map(({ view, label, entries, bindings, conflicts }) => <ShortcutColumn key={view} view={view} label={label} groups={getGroupsForView(view)} entries={entries} bindings={bindings} overrides={keyboardShortcuts[view]} conflicts={conflicts} onSet={setKeyboardShortcut} onReset={resetKeyboardShortcut} onResetAll={() => usePreferencesStore.getState().resetKeyboardShortcuts(view)} />)}
    </div>
  </>
}
