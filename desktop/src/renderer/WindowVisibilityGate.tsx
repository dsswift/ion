import { useEffect } from 'react'
import { rDebug } from './rendererLogger'

/**
 * Toggles `.ion-window-hidden` on the document root to reflect whether THIS
 * renderer's window is currently visible. Electron fires
 * document.visibilitychange for BrowserWindow hide/minimize/restore/show —
 * no IPC round-trip needed, it's native per-window state.
 *
 * Without this, a hidden or minimized window still ticks every `infinite`
 * CSS animation (pulse-dot, border-pulse, bounce-dot) at the display refresh
 * rate forever, which showed up as sustained GPU cost from a window with no
 * pixels on screen. CSS in index.css pauses those animations under
 * `.ion-window-hidden`.
 */
export function WindowVisibilityGate(): null {
  useEffect(() => {
    const apply = () => {
      const hidden = document.visibilityState === 'hidden'
      document.documentElement.classList.toggle('ion-window-hidden', hidden)
      rDebug('window.visibility', 'visibility changed', { hidden })
    }
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => document.removeEventListener('visibilitychange', apply)
  }, [])

  return null
}
