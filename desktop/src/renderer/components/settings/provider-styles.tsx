import React from 'react'
import { useColors } from '../../theme'

export type Colors = ReturnType<typeof useColors>

export function linkBtn(c: Colors): React.CSSProperties {
  return { padding: '1px 6px', background: 'transparent', color: c.textTertiary, border: `1px solid ${c.containerBorder}`, borderRadius: 4, fontSize: 10, cursor: 'pointer' }
}
export function oauthBtn(c: Colors, loading: boolean): React.CSSProperties {
  return { padding: '6px 14px', background: c.accent, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }
}
export function inputSt(c: Colors): React.CSSProperties {
  return { flex: 1, padding: '5px 8px', background: c.surfacePrimary, color: c.textPrimary, border: `1px solid ${c.containerBorder}`, borderRadius: 6, fontSize: 12, outline: 'none' }
}
export function saveBtn(c: Colors, disabled: boolean): React.CSSProperties {
  return { padding: '5px 10px', background: c.accent, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }
}

export interface DeviceCodeState { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }

export function DeviceCodeDisplay({ deviceCode, colors }: { deviceCode: DeviceCodeState; colors: Colors }) {
  return (
    <div style={{ padding: '8px 12px', background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 6, fontSize: 12, marginTop: 4 }}>
      <div style={{ marginBottom: 4, color: colors.textSecondary, fontSize: 11 }}>Enter this code on GitHub:</div>
      <div style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 700, letterSpacing: 2, color: colors.textPrimary, userSelect: 'all', marginBottom: 4 }}>{deviceCode.userCode}</div>
      <div style={{ fontSize: 10, color: colors.textTertiary, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={10} /> Waiting for authorization…</div>
    </div>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span style={{ display: 'inline-block', width: size, height: size, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'ion-spin 0.6s linear infinite', flexShrink: 0 }} />
}
