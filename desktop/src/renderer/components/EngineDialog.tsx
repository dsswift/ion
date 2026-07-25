import React, { useState } from 'react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { useSessionStore } from '../stores/sessionStore'

interface EngineDialogProps {
  tabId: string
}

/** One select-method option row. Extracted so `useInteractiveState` runs
 *  per row (hooks cannot run inside the parent's map). */
function OptionButton({ label, onPick }: { label: string; onPick: () => void }) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onPick}
      {...handlers}
      className="ion-focusable"
      style={{
        padding: '8px 12px',
        background: interactiveBg(colors, { hover, pressed }, colors.surfacePrimary),
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 8,
        color: colors.textPrimary,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 13,
        transition: `background ${transitions.base}`,
      }}
    >
      {label}
    </button>
  )
}

export function EngineDialog({ tabId }: EngineDialogProps) {
  const dialog = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const k = p?.activeInstanceId ? tabId : ''
    return k ? (s.engineDialogs.get(k) || null) : null
  })
  const respondEngineDialog = useSessionStore(s => s.respondEngineDialog)
  const colors = useColors()
  const [inputValue, setInputValue] = useState('')
  const noIx = useInteractiveState()
  const yesIx = useInteractiveState()
  const submitIx = useInteractiveState()

  if (!dialog) return null

  const handleSubmit = (value: any) => {
    respondEngineDialog(tabId, dialog.dialogId, value)
    setInputValue('')
  }

  return (
    <div
      data-ion-ui
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.scrim,
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: colors.containerBg,
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 12,
          padding: 20,
          maxWidth: 400,
          width: '90%',
          boxShadow: colors.containerShadow,
        }}
      >
        <h3 style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          {dialog.title}
        </h3>

        {dialog.method === 'select' && dialog.options && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {dialog.options.map((opt, i) => (
              <OptionButton key={i} label={opt} onPick={() => handleSubmit(opt)} />
            ))}
          </div>
        )}

        {dialog.method === 'confirm' && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => handleSubmit(false)}
              {...noIx.handlers}
              className="ion-focusable"
              style={{
                padding: '6px 16px',
                background: interactiveBg(colors, noIx, colors.surfacePrimary),
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 6,
                color: colors.textSecondary,
                cursor: 'pointer',
                fontSize: 13,
                transition: `background ${transitions.base}`,
              }}
            >
              No
            </button>
            <button
              onClick={() => handleSubmit(true)}
              {...yesIx.handlers}
              className="ion-focusable"
              style={{
                padding: '6px 16px',
                background: yesIx.pressed ? colors.accentPressed : yesIx.hover ? colors.accentHover : colors.accent,
                border: 'none',
                borderRadius: 6,
                color: colors.textOnAccent,
                cursor: 'pointer',
                fontSize: 13,
                transition: `background ${transitions.base}`,
              }}
            >
              Yes
            </button>
          </div>
        )}

        {dialog.method === 'input' && (
          <form onSubmit={(e) => { e.preventDefault(); handleSubmit(inputValue) }}>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={dialog.defaultValue || ''}
              autoFocus
              style={{
                width: '100%',
                padding: '8px 12px',
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 6,
                color: colors.textPrimary,
                fontSize: 13,
                marginBottom: 12,
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="submit"
                {...submitIx.handlers}
                className="ion-focusable"
                style={{
                  padding: '6px 16px',
                  background: submitIx.pressed ? colors.accentPressed : submitIx.hover ? colors.accentHover : colors.accent,
                  border: 'none',
                  borderRadius: 6,
                  color: colors.textOnAccent,
                  cursor: 'pointer',
                  fontSize: 13,
                  transition: `background ${transitions.base}`,
                }}
              >
                Submit
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
