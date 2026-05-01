import React from 'react'
import { useSessionStore } from '../stores/sessionStore'

/* ─── Backend Indicator (shows "CLI" when in CLI bridge proxy mode) ─── */

export function BackendIndicator() {
  const backend = useSessionStore((s) => s.backend)

  if (backend !== 'cli') return null

  return (
    <span style={{ color: '#e5a100', fontSize: 10, fontWeight: 500 }}>CLI</span>
  )
}
