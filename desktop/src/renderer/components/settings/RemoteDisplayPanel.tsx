import React, { useState, useEffect, useCallback } from 'react'
import {
  Desktop, Laptop, Monitor, HardDrives, Terminal,
  Briefcase, House, GameController, DesktopTower,
  type Icon,
} from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingHeading } from './SettingHeading'

/**
 * Curated icon set — identifiers must match the iOS-side mapping in
 * `DeviceCustomizationSheet.swift::iconForIdentifier(_:)`. Unknown
 * identifiers degrade gracefully to the default `desktop` icon on either
 * platform.
 */
const ICON_CHOICES: Array<{ id: string; label: string; Icon: Icon }> = [
  { id: 'desktop',   label: 'Desktop',         Icon: Desktop },
  { id: 'laptop',    label: 'Laptop',          Icon: Laptop },
  { id: 'macmini',   label: 'Mini',            Icon: DesktopTower },
  { id: 'macpro',    label: 'Pro',             Icon: HardDrives },
  { id: 'display',   label: 'Display',         Icon: Monitor },
  { id: 'server',    label: 'Server',          Icon: HardDrives },
  { id: 'terminal',  label: 'Terminal',        Icon: Terminal },
  { id: 'briefcase', label: 'Work',            Icon: Briefcase },
  { id: 'house',     label: 'Home',            Icon: House },
  { id: 'gamepad',   label: 'Game',            Icon: GameController },
]

/**
 * Renderer-side editor for the per-desktop display override (`remoteDisplay`).
 * The desktop owns this setting; this UI calls
 * `window.ion.remoteSetDisplay(name, icon)` which funnels through the same
 * main-process `setRemoteDisplay` helper that the iOS `set_remote_display`
 * command uses. Both edit paths produce identical persistence + broadcast.
 */
export function RemoteDisplayPanel() {
  const colors = useColors()
  const remoteDisplay = usePreferencesStore((s) => s.remoteDisplay)
  const setRemoteDisplay = usePreferencesStore((s) => s.setRemoteDisplay)

  const [draftName, setDraftName] = useState<string>(remoteDisplay?.customName ?? '')
  const [draftIcon, setDraftIcon] = useState<string | null>(remoteDisplay?.customIcon ?? null)
  const [saving, setSaving] = useState<boolean>(false)
  const [savedToast, setSavedToast] = useState<boolean>(false)

  // Keep the local draft in sync with store updates (e.g. iOS edited it while
  // we had the panel open, the 'ion:remote-display-changed' event below
  // refreshes the store, and we want the inputs to reflect that).
  useEffect(() => {
    setDraftName(remoteDisplay?.customName ?? '')
    setDraftIcon(remoteDisplay?.customIcon ?? null)
  }, [remoteDisplay?.customName, remoteDisplay?.customIcon, remoteDisplay?.updatedAt])

  // Listen for main-process broadcasts (after an iOS edit). The store update
  // is driven by the renderer's standard save path; the broadcast is a UI
  // hint so we don't have to wait for the next disk read.
  useEffect(() => {
    const handler = (
      _e: unknown,
      value: { customName: string | null; customIcon: string | null; updatedAt: number },
    ) => {
      console.log('[RemoteDisplay] received broadcast:', value)
      // Update store with authoritative value so other components stay in sync.
      usePreferencesStore.setState({ remoteDisplay: value })
    }
    window.ion?.on?.('ion:remote-display-changed', handler)
    return () => {
      window.ion?.off?.('ion:remote-display-changed', handler)
    }
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const trimmed = draftName.trim()
      const nameOut = trimmed.length > 0 ? trimmed : null
      const iconOut = draftIcon
      console.log(`[RemoteDisplay] save: name=${nameOut === null ? 'null' : 'set'} icon=${iconOut ?? 'null'}`)
      const result = await window.ion?.remoteSetDisplay?.(nameOut, iconOut)
      if (result) {
        usePreferencesStore.setState({ remoteDisplay: result })
        // Also call the store setter so saveSettings is triggered for the
        // renderer-side persisted shape (the main process already wrote, but
        // the renderer's loadPersistedSettings round-trip needs this).
        setRemoteDisplay(result.customName, result.customIcon)
      }
      setSavedToast(true)
      setTimeout(() => setSavedToast(false), 1500)
    } catch (err) {
      console.error('[RemoteDisplay] save failed:', err)
    } finally {
      setSaving(false)
    }
  }, [draftName, draftIcon, setRemoteDisplay])

  const handleReset = useCallback(async () => {
    setSaving(true)
    try {
      console.log('[RemoteDisplay] reset to default')
      const result = await window.ion?.remoteSetDisplay?.(null, null)
      if (result) {
        usePreferencesStore.setState({ remoteDisplay: result })
        setRemoteDisplay(null, null)
      }
      setDraftName('')
      setDraftIcon(null)
      setSavedToast(true)
      setTimeout(() => setSavedToast(false), 1500)
    } catch (err) {
      console.error('[RemoteDisplay] reset failed:', err)
    } finally {
      setSaving(false)
    }
  }, [setRemoteDisplay])

  return (
    <>
      <SettingHeading>This Desktop</SettingHeading>
      <p style={{ color: colors.textTertiary, fontSize: 12, margin: '0 0 10px' }}>
        Set a custom name and icon shown on every paired iPhone. Leave the
        name blank to use the OS hostname; pick a different icon to make
        this desktop easier to spot in the iOS device list.
      </p>

      {/* Name input */}
      <div style={{ marginBottom: 10 }}>
        <label
          htmlFor="remote-display-name"
          style={{ display: 'block', fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}
        >
          Custom name
        </label>
        <input
          id="remote-display-name"
          type="text"
          value={draftName}
          placeholder="(uses OS hostname)"
          onChange={(e) => setDraftName(e.target.value)}
          disabled={saving}
          style={{
            width: '100%',
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            padding: '6px 10px',
            color: colors.textPrimary,
            fontSize: 13,
            outline: 'none',
          }}
        />
      </div>

      {/* Icon grid */}
      <label style={{ display: 'block', fontSize: 12, color: colors.textSecondary, marginBottom: 6 }}>
        Icon
      </label>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))',
          gap: 6,
          marginBottom: 10,
        }}
      >
        {/* "Use default" tile — clears the icon override. */}
        <button
          type="button"
          onClick={() => setDraftIcon(null)}
          disabled={saving}
          title="Use default icon"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            padding: 8,
            minHeight: 56,
            background: draftIcon === null ? colors.accent + '22' : colors.surfacePrimary,
            border: `1px solid ${draftIcon === null ? colors.accent : colors.containerBorder}`,
            borderRadius: 8,
            cursor: 'pointer',
            color: colors.textPrimary,
            fontSize: 10,
          }}
        >
          <Desktop size={20} weight={draftIcon === null ? 'fill' : 'regular'} />
          <span>Default</span>
        </button>

        {ICON_CHOICES.map(({ id, label, Icon }) => {
          const selected = draftIcon === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setDraftIcon(id)}
              disabled={saving}
              title={label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                padding: 8,
                minHeight: 56,
                background: selected ? colors.accent + '22' : colors.surfacePrimary,
                border: `1px solid ${selected ? colors.accent : colors.containerBorder}`,
                borderRadius: 8,
                cursor: 'pointer',
                color: colors.textPrimary,
                fontSize: 10,
              }}
            >
              <Icon size={20} weight={selected ? 'fill' : 'regular'} />
              <span>{label}</span>
            </button>
          )
        })}
      </div>

      {/* Save + Reset */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            background: colors.accent,
            border: 'none',
            borderRadius: 8,
            padding: '6px 16px',
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: saving ? 'wait' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={saving}
          style={{
            background: 'none',
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            padding: '6px 12px',
            color: colors.textSecondary,
            fontSize: 12,
            cursor: saving ? 'wait' : 'pointer',
          }}
        >
          Reset to default
        </button>
        {savedToast && (
          <span style={{ color: colors.statusComplete, fontSize: 12 }}>
            ✓ Saved · syncs to all paired iPhones
          </span>
        )}
      </div>
    </>
  )
}
