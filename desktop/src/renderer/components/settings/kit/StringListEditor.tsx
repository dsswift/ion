/**
 * StringListEditor — edits a list of short strings (command prefixes,
 * directory names) inside a side panel: an add box on top, one row per
 * entry with a remove button, and a filter once the list is long.
 */
import React, { useState } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { Button, IconButton, TextInput } from './controls'
import { KIT } from './tokens'

export interface StringListEditorProps {
  label: string
  values: readonly string[]
  onChange(next: string[]): void
  placeholder?: string
  /** What an empty list means, in the list's own terms. */
  emptyText: string
  mono?: boolean
}

const FILTER_AT = 12

export function StringListEditor({ label, values, onChange, placeholder, emptyText, mono = true }: StringListEditorProps): React.JSX.Element {
  const colors = useColors()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const value = draft.trim()
  const duplicate = values.includes(value)
  const add = (): void => {
    if (!value || duplicate) return
    onChange([...values, value])
    setDraft('')
  }
  const q = query.trim().toLowerCase()
  const shown = q ? values.filter((v) => v.toLowerCase().includes(q)) : values
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <TextInput
          aria-label={`Add to ${label}`}
          mono={mono}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <Button icon={Plus} disabled={!value || duplicate} onClick={add} tooltip={duplicate ? 'Already in the list' : undefined}>Add</Button>
      </div>
      {values.length >= FILTER_AT && <TextInput aria-label={`Filter ${label}`} value={query} placeholder="Filter" onChange={(e) => setQuery(e.target.value)} />}
      <div role="list" aria-label={label} style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2, overflow: 'hidden' }}>
        {values.length === 0 && <div style={{ padding: `8px ${KIT.inset}px`, fontSize: KIT.fontSmall, color: colors.textTertiary }}>{emptyText}</div>}
        {shown.map((entry) => (
          <div key={entry} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: `0 4px 0 ${KIT.inset}px`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: KIT.fontSmall, color: colors.textPrimary, fontFamily: mono ? KIT.mono : undefined }}>{entry}</span>
            <IconButton icon={X} label={`Remove ${entry}`} onClick={() => onChange(values.filter((v) => v !== entry))} />
          </div>
        ))}
      </div>
      <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary }}>{values.length} {values.length === 1 ? 'entry' : 'entries'}</span>
    </div>
  )
}
