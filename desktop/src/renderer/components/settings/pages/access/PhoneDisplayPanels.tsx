/**
 * PhoneDisplayPanels — the name and icon every paired iPhone shows for this
 * desktop (`remoteDisplay`). Both panels save through
 * `host.shell.remoteSetDisplay(name, icon)`, the same main-process path the
 * iOS `set_remote_display` command uses, so either edit persists and
 * broadcasts the same way.
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Desktop, Laptop, Monitor, HardDrives, Terminal, Briefcase, House, GameController, DesktopTower, type Icon,
} from '@phosphor-icons/react'
import type { PreferencesState } from '@ion/server/preferences-types'
import { useColors } from '../../../../theme'
import { transitions } from '../../../../theme-tokens'
import { Button, Field, KIT, Muted, SidePanel, Stack, TextInput } from '../../kit'
import { useSettingsPreferences } from '../../settings-target'
import { useSettingsShell } from '../../settings-shell'
import { rError, rInfo } from '../../../../rendererLogger'

type RemoteDisplay = PreferencesState['remoteDisplay']

/**
 * Curated icon set — identifiers must match the iOS-side mapping in
 * `DeviceCustomizationSheet.swift::iconForIdentifier(_:)`. Unknown
 * identifiers degrade to the default `desktop` icon on either platform.
 */
export const ICON_CHOICES: Array<{ id: string; label: string; Icon: Icon }> = [
  { id: 'desktop', label: 'Desktop', Icon: Desktop },
  { id: 'laptop', label: 'Laptop', Icon: Laptop },
  { id: 'macmini', label: 'Mini', Icon: DesktopTower },
  { id: 'macpro', label: 'Pro', Icon: HardDrives },
  { id: 'display', label: 'Display', Icon: Monitor },
  { id: 'server', label: 'Server', Icon: HardDrives },
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'briefcase', label: 'Work', Icon: Briefcase },
  { id: 'house', label: 'Home', Icon: House },
  { id: 'gamepad', label: 'Game', Icon: GameController },
]

/** The icon the phone shows for an identifier; null or unknown is the default. */
export function iconChoice(id: string | null | undefined): { label: string; Icon: Icon } {
  return ICON_CHOICES.find((c) => c.id === id) ?? { label: 'Default', Icon: Desktop }
}

/** Saves a name and icon, with the saving flag and the short "saved" confirmation. */
function useDisplaySave(): { saving: boolean; saved: boolean; save(name: string | null, icon: string | null): void; reset(): void } {
  const { shell } = useSettingsShell()
  const setRemoteDisplay = useSettingsPreferences((s) => s.setRemoteDisplay)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 1500)
    return () => clearTimeout(timer)
  }, [saved])

  const apply = useCallback(async (name: string | null, icon: string | null): Promise<void> => {
    const result = await shell.remoteSetDisplay(name, icon)
    if (result) {
      useSettingsPreferences.setState({ remoteDisplay: result })
      // Also call the store setter so the renderer-side persisted shape is
      // saved; main already wrote, but the load round-trip needs this.
      setRemoteDisplay(result.customName, result.customIcon)
    }
    setSaved(true)
  }, [shell, setRemoteDisplay])

  const save = useCallback((name: string | null, icon: string | null): void => {
    setSaving(true)
    rInfo('remote.display', 'saving display settings', { has_name: name !== null, has_icon: icon !== null })
    apply(name, icon).catch((err: unknown) => rError('remote.display', 'save failed', { error: String(err) })).finally(() => setSaving(false))
  }, [apply])

  const reset = useCallback((): void => {
    setSaving(true)
    rInfo('remote.display', 'resetting to default')
    apply(null, null).catch((err: unknown) => rError('remote.display', 'reset failed', { error: String(err) })).finally(() => setSaving(false))
  }, [apply])

  return { saving, saved, save, reset }
}

const SAVED_TEXT = 'Saved · syncs to all paired iPhones'

export function DisplayNamePanel({ display, onClose }: { display: RemoteDisplay; onClose(): void }): React.JSX.Element {
  const { saving, saved, save, reset } = useDisplaySave()
  const [draft, setDraft] = useState(display?.customName ?? '')
  // An iOS edit arriving while the panel is open replaces the draft.
  useEffect(() => { setDraft(display?.customName ?? '') }, [display?.customName, display?.updatedAt])
  return (
    <SidePanel
      open
      title="Name on the phone"
      subtitle="Shown on every paired iPhone. Leave it blank to use the OS hostname."
      onClose={onClose}
      footer={<>
        <Button disabled={saving} onClick={reset}>Reset to default</Button>
        <Button variant="primary" disabled={saving} onClick={() => { const trimmed = draft.trim(); save(trimmed.length > 0 ? trimmed : null, display?.customIcon ?? null) }}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <Stack>
        <Field label="Custom name">
          <TextInput aria-label="Custom name" value={draft} placeholder="(uses OS hostname)" disabled={saving} onChange={(e) => setDraft(e.target.value)} />
        </Field>
        {saved && <Muted>{SAVED_TEXT}</Muted>}
      </Stack>
    </SidePanel>
  )
}

export function DisplayIconPanel({ display, onClose }: { display: RemoteDisplay; onClose(): void }): React.JSX.Element {
  const { saving, saved, save } = useDisplaySave()
  const [draft, setDraft] = useState<string | null>(display?.customIcon ?? null)
  useEffect(() => { setDraft(display?.customIcon ?? null) }, [display?.customIcon, display?.updatedAt])
  return (
    <SidePanel
      open
      title="Icon on the phone"
      subtitle="Pick an icon to make this desktop easier to spot in the iOS device list."
      onClose={onClose}
      footer={<Button variant="primary" disabled={saving} onClick={() => save(display?.customName ?? null, draft)}>{saving ? 'Saving…' : 'Save'}</Button>}
    >
      <Stack>
        <div role="radiogroup" aria-label="Icon" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
          <IconTile label="Default" Icon={Desktop} selected={draft === null} disabled={saving} onSelect={() => setDraft(null)} />
          {ICON_CHOICES.map((c) => <IconTile key={c.id} label={c.label} Icon={c.Icon} selected={draft === c.id} disabled={saving} onSelect={() => setDraft(c.id)} />)}
        </div>
        {saved && <Muted>{SAVED_TEXT}</Muted>}
      </Stack>
    </SidePanel>
  )
}

function IconTile({ label, Icon: IconComp, selected, disabled, onSelect }: { label: string; Icon: Icon; selected: boolean; disabled: boolean; onSelect(): void }): React.JSX.Element {
  const colors = useColors()
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
      className="ion-focusable"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, height: 52,
        fontSize: KIT.fontTiny, color: colors.textPrimary, cursor: disabled ? 'default' : 'pointer',
        background: selected ? colors.accentSoft : colors.surfacePrimary,
        border: `1px solid ${selected ? colors.accent : colors.containerBorder}`, borderRadius: KIT.radius,
        transition: `background ${transitions.base}`,
      }}
    >
      <IconComp size={18} weight={selected ? 'fill' : 'regular'} />
      <span>{label}</span>
    </button>
  )
}
