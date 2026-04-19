import React, { useState } from 'react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'

interface EngineDialogProps {
  tabId: string
}

export function EngineDialog({ tabId }: EngineDialogProps) {
  const dialog = useSessionStore(s => {
    const p = s.enginePanes.get(tabId)
    const k = p?.activeInstanceId ? `${tabId}:${p.activeInstanceId}` : ''
    return k ? (s.engineDialogs.get(k) || null) : null
  })
  const respondEngineDialog = useSessionStore(s => s.respondEngineDialog)
  const colors = useColors()
  const [inputValue, setInputValue] = useState('')

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
        backgroundColor: 'rgba(0,0,0,0.4)',
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
              <button
                key={i}
                onClick={() => handleSubmit(opt)}
                style={{
                  padding: '8px 12px',
                  background: colors.surfacePrimary,
                  border: `1px solid ${colors.containerBorder}`,
                  borderRadius: 8,
                  color: colors.textPrimary,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 13,
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {dialog.method === 'confirm' && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => handleSubmit(false)}
              style={{
                padding: '6px 16px',
                background: colors.surfacePrimary,
                border: `1px solid ${colors.containerBorder}`,
                borderRadius: 6,
                color: colors.textSecondary,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              No
            </button>
            <button
              onClick={() => handleSubmit(true)}
              style={{
                padding: '6px 16px',
                background: colors.accent,
                border: 'none',
                borderRadius: 6,
                color: '#fff',
                cursor: 'pointer',
                fontSize: 13,
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
                style={{
                  padding: '6px 16px',
                  background: colors.accent,
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
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
