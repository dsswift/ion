import { useEffect } from 'react'
import { usePreferencesStore } from '../preferences'

/**
 * Read the OS theme on mount and subscribe to OS theme changes. The
 * preferences store decides whether the OS value is honored (themeMode =
 * system) or overridden (light/dark).
 */
export function useThemeSync() {
  const setSystemTheme = usePreferencesStore((s) => s.setSystemTheme)

  useEffect(() => {
    window.ion.getTheme().then(({ isDark }) => {
      setSystemTheme(isDark)
    }).catch(() => {})

    const unsub = window.ion.onThemeChange((isDark) => {
      setSystemTheme(isDark)
    })
    return unsub
  }, [setSystemTheme])
}
