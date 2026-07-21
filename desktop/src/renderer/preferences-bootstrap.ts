/**
 * preferences-bootstrap — module-load startup side effects for the
 * preferences store, extracted from preferences.ts (600-line cap split).
 *
 * Everything here runs exactly once, when preferences.ts finishes creating
 * the store and calls bootstrapPreferences(). The store is passed in as an
 * argument (not imported) so this module has no import cycle back into
 * preferences.ts.
 */
import type { StoreApi, UseBoundStore } from 'zustand'
import { applyTheme, syncTokensToCss, darkColors, lightColors, getTheme } from './theme-tokens'
import type { PreferencesState } from './preferences-types'
import { INITIAL_SAVED, loadPersistedSettings } from './preferences-persist'

type PreferencesStore = UseBoundStore<StoreApi<PreferencesState>>

/**
 * Run the one-time startup sequence: seed theme CSS variables, hydrate
 * persisted settings from disk, fetch enterprise policies from the engine,
 * and subscribe to main-process settings pushes.
 */
export function bootstrapPreferences(store: PreferencesStore, savedThemeId: string): void {
  // Initialize CSS vars with saved theme
  if (getTheme(savedThemeId).forcedColorScheme) {
    syncTokensToCss(getTheme(savedThemeId).colors)
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  } else {
    syncTokensToCss(INITIAL_SAVED.themeMode === 'light' ? lightColors : darkColors)
  }

  // Load persisted settings from disk (async, fires once on startup)
  loadPersistedSettings(
    (patch) => store.setState(patch),
    () => store.getState(),
    applyTheme,
  )

  // Load enterprise policy from engine at startup (async, not persisted).
  // Errors are non-fatal: the app runs without enterprise constraints.
  window.ion?.getEnterprisePolicy?.()?.then?.((policy) => {
    store.getState().setEnterpriseNewConversationDefaults(policy)
  })?.catch?.(() => {
    // Engine not yet ready or no enterprise config — leave null.
  })

  // Full enterprise policy blob (D-004): model allowlist (D-011) and every
  // other renderer-side enterprise constraint ride this. Same non-fatal
  // semantics as the new-conversation policy above.
  window.ion?.getEnterprisePolicyFull?.()?.then?.((policy) => {
    store.getState().setEnterprisePolicy(policy)
  })?.catch?.(() => {
    // Engine not yet ready or no enterprise config — leave null.
  })

  // Listen for settings changes pushed from the main process (e.g. iOS
  // `set_desktop_setting` writes). Without this, iOS-originated changes
  // only land on disk — the renderer Zustand store keeps the stale
  // in-memory value until the next restart.
  window.ion?.on?.('ion:settings-changed', (_e: unknown, key: string, value: unknown) => {
    const current = store.getState()
    if (key in current && (current as unknown as Record<string, unknown>)[key] !== value) {
      store.setState({ [key]: value })
    }
  })
}
