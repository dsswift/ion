/**
 * KeyboardShortcutsCategory — editable, config-backed shortcuts panel.
 *
 * Renders every catalog command grouped by section. Each row is editable:
 * click the chord to capture a new binding. Customized rows show a "custom"
 * badge and a per-row Reset button. Conflicts are flagged inline.
 *
 * Bindings persist to ~/.ion/settings.json under `keyboardShortcuts` and can
 * be edited externally or deployed by an enterprise as a prepared file.
 *
 * Under the 600-line cap (capture logic lives in ShortcutRow.tsx).
 */

import React, { useMemo } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SHORTCUT_CATALOG, SHORTCUT_GROUPS, resolveBindings } from '../../shortcuts/shortcut-catalog'
import { SettingHeading } from './SettingHeading'
import { ShortcutRow } from './ShortcutRow'

export function KeyboardShortcutsCategory() {
  const colors = useColors()
  const keyboardShortcuts = usePreferencesStore((s) => s.keyboardShortcuts)
  const setKeyboardShortcut = usePreferencesStore((s) => s.setKeyboardShortcut)
  const resetKeyboardShortcut = usePreferencesStore((s) => s.resetKeyboardShortcut)
  const resetAllKeyboardShortcuts = usePreferencesStore((s) => s.resetAllKeyboardShortcuts)

  // Build the resolved binding map (defaults ⊕ overrides). Recomputed when
  // overrides change. resolveBindings also logs conflicts.
  const bindings = useMemo(() => resolveBindings(keyboardShortcuts), [keyboardShortcuts])

  // Build a map of chordKey -> [commandIds] for conflict detection display.
  // A chord is conflicted when two+ commands resolve to it (resolveBindings
  // already removes the loser; we detect it by checking which catalog entries
  // are absent from the resolved map).
  const chordConflicts = useMemo(() => {
    const conflicts = new Map<string, string>() // commandId -> winner commandId
    const _catalogDefaultMap = new Map<string, string>() // chordKey -> commandId for resolved
    for (const entry of SHORTCUT_CATALOG) {
      if (!bindings.has(entry.id)) {
        // This entry lost a conflict. Find which command has its chord.
        const override = keyboardShortcuts[entry.id] ?? entry.defaultBinding
        const winner = [...bindings.entries()].find(([, chord]) => {
          const parts = [
            chord.mod ? 'Mod' : '',
            chord.ctrl ? 'Ctrl' : '',
            chord.shift ? 'Shift' : '',
            chord.alt ? 'Alt' : '',
            chord.key,
          ].filter(Boolean).join('+')
          return parts === override
        })
        if (winner) conflicts.set(entry.id, winner[0])
      }
    }
    return conflicts
  }, [bindings, keyboardShortcuts])

  const hasCustomizations = Object.keys(keyboardShortcuts).length > 0

  return (
    <>
      {/* Header with restore-defaults button */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: colors.textTertiary }}>
          Bindings persist to <code style={{ fontFamily: 'monospace', fontSize: 11 }}>~/.ion/settings.json</code> under{' '}
          <code style={{ fontFamily: 'monospace', fontSize: 11 }}>keyboardShortcuts</code>. Edit externally or deploy as an enterprise config.
        </span>
        {hasCustomizations && (
          <button
            onClick={resetAllKeyboardShortcuts}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 6,
              border: `1px solid ${colors.inputBorder}`,
              background: 'transparent',
              color: colors.textSecondary,
              cursor: 'pointer',
              flexShrink: 0,
              marginLeft: 12,
              whiteSpace: 'nowrap',
            }}
          >
            Restore Defaults
          </button>
        )}
      </div>

      {/* Groups */}
      {SHORTCUT_GROUPS.map((group, groupIdx) => {
        const entries = SHORTCUT_CATALOG.filter((e) => e.group === group)
        if (entries.length === 0) return null
        return (
          <React.Fragment key={group}>
            <SettingHeading first={groupIdx === 0}>{group}</SettingHeading>
            <div style={{ marginBottom: 8 }}>
              {entries.map((entry) => {
                const chord = bindings.get(entry.id) ?? null
                const isCustom = entry.id in keyboardShortcuts
                const conflictsWith = chordConflicts.get(entry.id) ?? null
                return (
                  <ShortcutRow
                    key={entry.id}
                    entry={entry}
                    resolvedChord={chord}
                    isCustom={isCustom}
                    conflictsWith={conflictsWith}
                    onSet={setKeyboardShortcut}
                    onReset={resetKeyboardShortcut}
                  />
                )
              })}
            </div>
          </React.Fragment>
        )
      })}
    </>
  )
}
