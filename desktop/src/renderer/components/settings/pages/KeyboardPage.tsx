/**
 * KeyboardPage — every Studio shortcut, one row each, grouped as the
 * catalog groups them. Clicking a chord captures the next key combination;
 * Escape or a click anywhere else cancels. While a capture is live, Escape
 * belongs to the capture, not to the dialog.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { getCatalogForView, getGroupsForView, resolveViewBindings } from '../../../preferences-shortcuts'
import { baseKeyFromCode, formatChord, parseChord, type Chord } from '../../../shortcuts/chord'
import type { ShortcutEntry } from '../../../shortcuts/shortcut-types'
import { Tooltip } from '../../git/Tooltip'
import { useSettingsPreferences } from '../settings-target'
import { Button, Chip, FormGroup, FormRow, IconButton, KIT, Stack, useEscapeLayer } from '../kit'

// Studio is the only view that has shortcuts.
const VIEW = 'studio' as const

/** A keydown as a chord string in the catalog format, or null for a bare modifier. */
export function eventToChordString(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null
  const parts: string[] = []
  if (e.metaKey || (e.ctrlKey && !e.metaKey)) parts.push(e.metaKey ? 'Mod' : 'Ctrl')
  if (e.ctrlKey && e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  // With Option held, macOS reports the Option-layer character in `key`
  // (⌥1 arrives as `¡`); an Alt capture records the physical key instead.
  const base = e.altKey && e.code ? baseKeyFromCode(e.code) : null
  parts.push(base ?? e.key)
  return parts.join('+')
}

function chordLabel(chord: Chord | null): string {
  if (!chord) return '—'
  return formatChord([chord.mod ? 'Mod' : '', chord.ctrl ? 'Ctrl' : '', chord.shift ? 'Shift' : '', chord.alt ? 'Alt' : '', chord.key].filter(Boolean).join('+'))
}

export function KeyboardPage(): React.JSX.Element {
  const keyboardShortcuts = useSettingsPreferences((s) => s.keyboardShortcuts)
  const setKeyboardShortcut = useSettingsPreferences((s) => s.setKeyboardShortcut)
  const resetKeyboardShortcut = useSettingsPreferences((s) => s.resetKeyboardShortcut)
  const resetAllKeyboardShortcuts = useSettingsPreferences((s) => s.resetAllKeyboardShortcuts)
  const overrides = keyboardShortcuts[VIEW]

  const { entries, bindings, conflicts } = useMemo(() => {
    const resolution = resolveViewBindings(VIEW, overrides)
    return {
      entries: getCatalogForView(VIEW),
      bindings: new Map(resolution.shortcuts.map((s) => [s.entry.id, s.binding])),
      conflicts: new Map(resolution.shortcuts.flatMap((s) => s.conflictsWith ? [[s.entry.id, s.conflictsWith] as const] : [])),
    }
  }, [overrides])

  const customized = Object.values(keyboardShortcuts).reduce((n, o) => n + Object.keys(o).length, 0)

  return (
    <Stack gap={KIT.groupGap}>
      <FormGroup title="Customizations" description={<>Shortcut customizations persist in <code>~/.ion/settings.json</code>.</>} anchor="shortcuts">
        <FormRow label="Custom bindings" settingKey="keyboardShortcuts" description={customized > 0 ? `${customized} ${customized === 1 ? 'shortcut differs' : 'shortcuts differ'} from the default.` : 'Every shortcut uses its default.'}>
          {customized > 0 && <Button onClick={resetAllKeyboardShortcuts}>Restore all defaults</Button>}
        </FormRow>
      </FormGroup>
      {getGroupsForView(VIEW).map((group) => {
        const groupEntries = entries.filter((e) => e.group === group)
        if (groupEntries.length === 0) return null
        return (
          <FormGroup key={group} title={group}>
            {groupEntries.map((entry) => {
              const binding = bindings.get(entry.id)
              return (
                <ShortcutRow
                  key={entry.id}
                  entry={entry}
                  chord={binding ? parseChord(binding) : null}
                  isCustom={entry.id in overrides}
                  conflictsWith={conflicts.get(entry.id) ?? null}
                  onSet={(chord) => setKeyboardShortcut(VIEW, entry.id, chord)}
                  onReset={() => resetKeyboardShortcut(VIEW, entry.id)}
                />
              )
            })}
          </FormGroup>
        )
      })}
    </Stack>
  )
}

function ShortcutRow({ entry, chord, isCustom, conflictsWith, onSet, onReset }: {
  entry: ShortcutEntry
  chord: Chord | null
  isCustom: boolean
  conflictsWith: string | null
  onSet(chord: string): void
  onReset(): void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  useEscapeLayer(capturing, () => setCapturing(false))

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setCapturing(false); return }
      const next = eventToChordString(e)
      if (!next || !parseChord(next)) return
      onSet(next)
      setCapturing(false)
    }
    const onDown = (): void => setCapturing(false)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [capturing, onSet])

  return (
    <FormRow label={entry.description} settingKey="keyboardShortcuts">
      {conflictsWith && <Tooltip text={`Conflict with: ${conflictsWith}`}><Chip tone="error">conflict</Chip></Tooltip>}
      {isCustom && !conflictsWith && <Chip tone="accent">custom</Chip>}
      <span onMouseDown={(e) => { if (capturing) e.stopPropagation() }}>
        <Button variant={capturing ? 'primary' : 'secondary'} aria-label={`Shortcut for ${entry.description}`} onClick={() => setCapturing(true)}>
          <span style={{ fontFamily: KIT.mono, minWidth: 70, textAlign: 'center' }}>{capturing ? 'Press keys…' : chordLabel(chord)}</span>
        </Button>
      </span>
      {isCustom && <IconButton icon={ArrowCounterClockwise} label="Reset to default" onClick={onReset} />}
    </FormRow>
  )
}
