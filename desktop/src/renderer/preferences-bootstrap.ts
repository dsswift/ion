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
import { applyTheme, onThemeRegistryChanged, registerCustomThemes } from './theme-tokens'
import type { PreferencesState } from './preferences-types'
import type { CustomThemeForRenderer } from '../shared/theme-pack-types'
import { deriveEnterpriseThemePolicy } from '../shared/enterprise-theme-policy'
import { loadPersistedSettings } from './preferences-persist'
import { rError, rInfo } from './rendererLogger'

type PreferencesStore = UseBoundStore<StoreApi<PreferencesState>>

/**
 * The theme id that must actually render: the enterprise-enforced id when
 * a locked policy is present, otherwise the caller's (user) choice. The
 * user's saved pick is never overwritten by enforcement — it resumes when
 * the policy lifts.
 */
function effectiveThemeId(store: PreferencesStore, userChoice: string): string {
  const policy = deriveEnterpriseThemePolicy(store.getState().enterprisePolicy)
  return policy?.locked ? policy.themeId : userChoice
}

/**
 * Run the one-time startup sequence: seed theme CSS variables, hydrate
 * persisted settings from disk, fetch enterprise policies from the engine,
 * and subscribe to main-process settings pushes.
 */
let preferencesReady: Promise<void> | null = null

export function bootstrapPreferencesReady(): Promise<void> {
  return preferencesReady ?? Promise.resolve()
}

export function bootstrapPreferences(store: PreferencesStore, savedThemeId: string): void {
  // Initialize CSS vars + scheme classes with the saved theme so the first
  // paint is already correct (disk hydration below may still change it).
  applyTheme(savedThemeId)

  // Load persisted settings from disk (async, fires once on startup).
  // The theme callback routes through the enterprise gate: if the policy
  // fetch below resolved first with a lock, the disk value must not win.
  preferencesReady = loadPersistedSettings(
    (patch) => store.setState(patch),
    () => store.getState(),
    (id) => applyTheme(effectiveThemeId(store, id)),
  )

  // Whenever the custom-theme registry changes (boot fetch below or a live
  // ion:themes-changed push), re-apply the effective theme: a selected (or
  // enforced) custom theme just arrived/updated, or was removed (getTheme
  // falls back to ion-dark visually; the saved id is kept so the choice
  // restores if the pack returns).
  onThemeRegistryChanged(() => {
    applyTheme(effectiveThemeId(store, store.getState().selectedTheme))
  })

  // Custom theme packs: fetch the installed set once at boot. Built-ins are
  // compiled in, so this only affects users with packs on disk; the initial
  // applyTheme above already painted correctly for built-in selections.
  window.ion?.listCustomThemes?.()?.then?.((customs: CustomThemeForRenderer[]) => {
    registerCustomThemes(customs ?? [])
  })?.catch?.((err: unknown) => {
    rError('preferences', 'listCustomThemes failed; custom themes unavailable', { error: String(err) })
  })

  // Live pack-set updates (fs watcher / sync-time rescan in main).
  window.ion?.on?.('ion:themes-changed', (_e: unknown, customs: CustomThemeForRenderer[]) => {
    registerCustomThemes(customs ?? [])
  })

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
    // Enterprise theme policy: locked → the enforced theme renders now and
    // the picker disables (AppearanceCategory reads the same derivation);
    // unlocked → managed DEFAULT, honored only when this profile has never
    // picked a theme (a fresh install on a managed machine boots branded).
    const themePolicy = deriveEnterpriseThemePolicy(policy)
    if (themePolicy?.locked) {
      rInfo('preferences', 'enterprise theme lock active', { theme_id: themePolicy.themeId })
      applyTheme(themePolicy.themeId)
    } else if (themePolicy && !localStorage.getItem('ion_selectedTheme')) {
      rInfo('preferences', 'enterprise managed default theme applied', { theme_id: themePolicy.themeId })
      store.getState().setSelectedTheme(themePolicy.themeId)
    }
  })?.catch?.(() => {
    // Engine not yet ready or no enterprise config — leave null.
  })

  // Listen for settings changes pushed from the main process (e.g. iOS
  // `set_desktop_setting` writes). Without this, iOS-originated changes
  // only land on disk — the renderer Zustand store keeps the stale
  // in-memory value until the next restart.
  window.ion?.on?.('ion:settings-changed', (_e: unknown, key: string, value: unknown) => {
    const current = store.getState()
    if (!(key in current) || (current as unknown as Record<string, unknown>)[key] === value) return
    // Theme selection must go through the setter so the palette is applied
    // (and localStorage mirrored) — a bare setState only updates the store.
    if (key === 'selectedTheme' && typeof value === 'string') {
      current.setSelectedTheme(value)
      return
    }
    store.setState({ [key]: value })
  })
}
