/**
 * FleetTargetPicker — which servers get a clone. A server that already
 * holds the repository is shown as having it and cannot be ticked; one that
 * is not connected cannot be asked.
 */
import React from 'react'
import { useColors } from '../../theme'
import { KIT } from '../../components/settings/kit'
import type { FleetServerChoice } from './fleet-servers'

export interface FleetTargetPickerProps {
  servers: readonly FleetServerChoice[]
  selected: ReadonlySet<string>
  /** Servers that already hold the repository. */
  holders?: ReadonlySet<string>
  disabled?: boolean
  onChange(next: ReadonlySet<string>): void
}

export function FleetTargetPicker({ servers, selected, holders, disabled, onChange }: FleetTargetPickerProps): React.JSX.Element {
  const colors = useColors()
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(selected)
    if (on) next.add(id); else next.delete(id)
    onChange(next)
  }
  return (
    <div role="group" aria-label="Servers to clone onto" style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2, maxHeight: KIT.listMaxHeight, overflowY: 'auto' }}>
      {servers.map((server) => {
        const holds = holders?.has(server.id) === true
        const unavailable = holds || !server.online
        const note = holds ? 'already here' : server.online ? null : 'offline'
        return (
          <label key={server.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: KIT.rowHeight, padding: `0 ${KIT.inset}px`, boxSizing: 'border-box', borderBottom: `1px solid ${colors.borderSubtle}`, cursor: unavailable || disabled ? 'default' : 'pointer', opacity: unavailable ? 0.6 : 1 }}>
            <input type="checkbox" aria-label={`Clone onto ${server.label}`} checked={!unavailable && selected.has(server.id)} disabled={unavailable || disabled} onChange={(e) => toggle(server.id, e.target.checked)} style={{ accentColor: colors.accent, margin: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: KIT.fontSmall, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.label}</span>
            {note && <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary }}>{note}</span>}
          </label>
        )
      })}
    </div>
  )
}
