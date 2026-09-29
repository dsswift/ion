/**
 * RenameServerPanel — renames a server on this device. The name is the
 * catalog label; the server itself is untouched. Opened from the Servers
 * list and from a server's Overview.
 */
import React, { useState } from 'react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { rInfo } from '../../../rendererLogger'
import { useSettingsServers } from '../settings-servers'
import { Button, Field, SidePanel, TextInput } from '../kit'

export function RenameServerPanel({ entry, onClose }: { entry: EnvironmentCatalogEntry | null; onClose(): void }): React.JSX.Element | null {
  return entry ? <RenameFlow key={entry.id} entry={entry} onClose={onClose} /> : null
}

function RenameFlow({ entry, onClose }: { entry: EnvironmentCatalogEntry; onClose(): void }): React.JSX.Element {
  const { relabel } = useSettingsServers()
  const [label, setLabel] = useState(entry.label)
  const next = label.trim()
  const changed = next !== '' && next !== entry.label
  const save = (): void => {
    if (!changed) return
    rInfo('settings.servers', 'rename requested', { environment_id: entry.id })
    relabel(entry, next)
    onClose()
  }
  return (
    <SidePanel
      open
      title={`Rename ${entry.label}`}
      subtitle="The name this device shows for the server."
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!changed} onClick={save}>Save</Button>
      </>}
    >
      <Field label="Name">
        <TextInput aria-label="Server name" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
      </Field>
    </SidePanel>
  )
}
