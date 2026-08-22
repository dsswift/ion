import React from 'react'
import type { ShortcutView } from '../../preferences-shortcuts'
import { ShortcutRow } from './ShortcutRow'
import { SettingHeading } from './SettingHeading'
import { useColors } from '../../theme'
import type { ShortcutEntry, ShortcutGroup } from '../../shortcuts/shortcut-types'
import { parseChord } from '../../shortcuts/chord'

interface ShortcutColumnProps {
  view: ShortcutView
  label: string
  groups: readonly ShortcutGroup[]
  entries: readonly ShortcutEntry[]
  bindings: Map<string, string>
  overrides: Record<string, string>
  conflicts: Map<string, string>
  onSet: (view: ShortcutView, commandId: string, chord: string) => void
  onReset: (view: ShortcutView, commandId: string) => void
  onResetAll: (view: ShortcutView) => void
}

export function ShortcutColumn({ view, label, groups, entries, bindings, overrides, conflicts, onSet, onReset, onResetAll }: ShortcutColumnProps) {
  const colors = useColors()
  const hasCustomizations = Object.keys(overrides).length > 0

  return (
    <section style={{ flex: 1, minWidth: 360 }}>
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
        <strong style={{ fontSize: 14 }}>{label}</strong>
        {hasCustomizations && <button onClick={() => onResetAll(view)} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: `1px solid ${colors.inputBorder}`, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' }}>Restore {label} defaults</button>}
      </div>
      {groups.map((group, groupIdx) => {
        const groupEntries = entries.filter((entry) => entry.group === group)
        if (groupEntries.length === 0) return null
        return <React.Fragment key={group}>
          <SettingHeading first={groupIdx === 0}>{group}</SettingHeading>
          <div style={{ marginBottom: 8 }}>
            {groupEntries.map((entry) => <ShortcutRow key={entry.id} entry={entry} resolvedChord={bindings.get(entry.id) ? parseChord(bindings.get(entry.id)!) : null} isCustom={entry.id in overrides} conflictsWith={conflicts.get(entry.id) ?? null} onSet={(id, chord) => onSet(view, id, chord)} onReset={(id) => onReset(view, id)} />)}
          </div>
        </React.Fragment>
      })}
    </section>
  )
}
