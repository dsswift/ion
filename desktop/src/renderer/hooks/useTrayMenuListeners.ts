import { useEffect } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { host } from '../host/host-instance'

/**
 * Subscribe to IPC events fired from the system tray menu. Today this is
 * just "show settings"; new tray-driven actions get added here so App.tsx
 * does not accumulate listener registration code.
 */
export function useTrayMenuListeners() {
  useEffect(() => {
    // No OS tray in a browser tab -- BrowserStudioHost already omits
    // 'tray' from capabilities() for exactly this reason; this call site
    // just never checked it.
    if (!host.capabilities().includes('tray')) return
    const unsub = host.shell.onShowSettings(() => {
      useSessionStore.getState().openSettings()
    })
    return unsub
  }, [])
}
