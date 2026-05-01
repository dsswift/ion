import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

/**
 * Subscribe to IPC events fired from the system tray menu. Today this is
 * just "show settings"; new tray-driven actions get added here so App.tsx
 * does not accumulate listener registration code.
 */
export function useTrayMenuListeners() {
  useEffect(() => {
    const unsub = window.ion.onShowSettings(() => {
      useSessionStore.getState().openSettings()
    })
    return unsub
  }, [])
}
