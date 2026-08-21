/**
 * InterfacePicker — the Settings "Interface" control (single-UI
 * exclusivity, F5): Overlay / Ion Studio, no 'both'. Per-machine (never
 * projectable — desktop windows only; iOS has nothing to render).
 *
 * Enterprise lock: when activeUiPolicy is locked the control disables
 * with "managed by your organization" (theme-picker precedent).
 *
 * Selecting a mode LIVE-switches (applyActiveUiSwitch in main): the
 * current UI closes, the other opens, shortcuts re-register — the owner
 * renderer and every conversation keep running.
 */
import React, { useEffect, useState } from 'react'
import { useColors } from '../../theme'
import { SettingSection } from './SettingSection'
import { rError } from '../../rendererLogger'

type ActiveUi = 'overlay' | 'studio'

export function InterfacePicker(): React.JSX.Element | null {
  const colors = useColors()
  const [state, setState] = useState<{ activeUi: ActiveUi; locked: boolean } | null>(null)

  useEffect(() => {
    let mounted = true
    void window.ion
      .getActiveUi()
      .then((s) => {
        if (mounted) setState(s)
      })
      .catch((err) => rError('settings', 'getActiveUi failed', { error: String(err) }))
    return () => {
      mounted = false
    }
  }, [])

  if (!state) return null

  const select = (ui: ActiveUi): void => {
    if (state.locked || ui === state.activeUi) return
    setState({ ...state, activeUi: ui })
    void window.ion
      .setActiveUi(ui)
      .then((ok) => {
        if (!ok) {
          rError('settings', 'setActiveUi rejected', { ui })
          void window.ion.getActiveUi().then((s) => setState(s)).catch(() => undefined) // silent-ok: refresh after a rejected write; the stale UI self-corrects on reopen
        }
      })
      .catch((err) => rError('settings', 'setActiveUi failed', { error: String(err) }))
  }

  return (
    <SettingSection
      label="Interface"
      description={
        state.locked
          ? 'The active interface is managed by your organization.'
          : 'Which conversation interface Ion presents. Switching applies immediately — conversations keep running.'
      }
    >
      <div style={{ display: 'flex', gap: 8 }}>
        {(
          [
            { id: 'overlay' as const, label: 'Overlay' },
            { id: 'studio' as const, label: 'Ion Studio' },
          ]
        ).map((option) => {
          const selected = state.activeUi === option.id
          return (
            <button
              key={option.id}
              onClick={() => select(option.id)}
              disabled={state.locked}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: 8,
                border: `1px solid ${selected ? colors.accent : colors.containerBorder}`,
                background: selected ? colors.accentLight : colors.surfacePrimary,
                color: state.locked ? colors.textTertiary : selected ? colors.accent : colors.textPrimary,
                fontSize: 13,
                fontWeight: selected ? 600 : 400,
                cursor: state.locked ? 'default' : 'pointer',
                opacity: state.locked && !selected ? 0.5 : 1,
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </SettingSection>
  )
}
