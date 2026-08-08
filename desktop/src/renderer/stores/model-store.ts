import { create } from 'zustand'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'
import { rDebug } from '../rendererLogger'

/** Live state of an in-flight delegated-CLI login, keyed by provider id. */
export interface ProviderLoginState {
  phase: 'waiting' | 'await_code' | 'error'
  url?: string
  userCode?: string
  verificationUrl?: string
  error?: string
}

interface ModelStoreState {
  models: ModelEntry[]
  providers: ProviderEntry[]
  loading: boolean
  lastFetched: number
  loginStates: Record<string, ProviderLoginState>
  fetchModels: () => Promise<void>
  setLoginState: (provider: string, state: ProviderLoginState | null) => void
  getAvailableModels: () => ModelEntry[]
  getModelsByProvider: () => Map<string, ModelEntry[]>
  findModel: (id: string) => ModelEntry | undefined
}

export const useModelStore = create<ModelStoreState>((set, get) => ({
  models: [],
  providers: [],
  loading: false,
  lastFetched: 0,
  loginStates: {},

  setLoginState: (provider, state) =>
    set((s) => {
      const next = { ...s.loginStates }
      if (state === null) delete next[provider]
      else next[provider] = state
      return { loginStates: next }
    }),

  fetchModels: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const result = await window.ion.listModels()
      const models = result.models || []
      set({
        models,
        providers: result.providers || [],
        lastFetched: Date.now(),
        loading: false,
      })
      // Preferences bootstrap owns renderer-only document side effects. Import
      // it only after live model metadata arrives so model-label helpers remain
      // usable in Node test environments and other non-renderer consumers.
      try {
        const { usePreferencesStore } = await import('../preferences')
        usePreferencesStore.getState().normalizeModelPreferences(models)
      } catch (err) {
        rDebug('model-store', 'normalize model preferences failed', { error: String(err) })
      }
    } catch {
      set({ loading: false })
    }
  },

  getAvailableModels: () => {
    const { models, providers } = get()
    const authProviders = new Set(providers.filter((p) => p.hasAuth).map((p) => p.id))
    return models.filter((m) => authProviders.has(m.providerId))
  },

  getModelsByProvider: () => {
    const { models } = get()
    const grouped = new Map<string, ModelEntry[]>()
    for (const m of models) {
      const list = grouped.get(m.providerId) || []
      list.push(m)
      grouped.set(m.providerId, list)
    }
    return grouped
  },

  findModel: (id: string) => {
    return get().models.find((m) => m.id === id)
  },
}))

const MODEL_REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

/**
 * Delegated-CLI backends whose binary opens its own browser during login.
 * For these the engine's await_browser URL is the CLI's printed *fallback*
 * (a different redirect_uri that cannot self-complete), so auto-opening it
 * would produce a second, dead-end tab. Surfaced on demand instead.
 */
const CLI_OPENS_OWN_BROWSER = new Set(['claude-code'])

/**
 * Call once from app initialization to set up background model sync.
 * - Fetches models immediately
 * - Refreshes periodically (every 5 minutes)
 * - Listens for main-process cache updates (engine reconnect, credential changes)
 */
export function setupModelSync(): void {
  // Initial fetch
  void useModelStore.getState().fetchModels().catch((err) => rDebug('model-store', 'initial fetchModels failed', { error: String(err) }))

  // Periodic refresh
  setInterval(() => {
    void useModelStore.getState().fetchModels().catch((err) => rDebug('model-store', 'periodic fetchModels failed', { error: String(err) }))
  }, MODEL_REFRESH_INTERVAL)

  // Listen for main process model cache updates
  window.ion.on('ion:models-updated', () => {
    void useModelStore.getState().fetchModels().catch((err) => rDebug('model-store', 'fetchModels on cache-update failed', { error: String(err) }))
  })

  // Delegated-CLI (codex/claude-code/grok/cursor) login lifecycle. Each stage
  // updates the per-provider login state the settings UI renders; terminal
  // stages clear it.
  const loginTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearTimer = (provider: string) => {
    const t = loginTimers.get(provider)
    if (t) { clearTimeout(t); loginTimers.delete(provider) }
  }
  // Abandon an in-flight login after `ms` so a browser flow the user never
  // finishes cannot leave the row spinning (and leaks no engine-side login).
  const armTimeout = (provider: string, ms: number) => {
    clearTimer(provider)
    loginTimers.set(provider, setTimeout(() => {
      useModelStore.getState().setLoginState(provider, { phase: 'error', error: 'Sign-in timed out' })
      void window.ion.providerLoginCancel(provider)
    }, ms))
  }
  window.ion.onProviderLoginEvent((u) => {
    const store = useModelStore.getState()
    switch (u.stage) {
      case 'started':
        store.setLoginState(u.provider, { phase: 'waiting' })
        armTimeout(u.provider, 120_000)
        break
      // await_browser carries a URL for the consumer to open — EXCEPT for a
      // driver whose CLI already opened its own browser. claude-code does: it
      // starts a loopback callback server and opens that tab itself, then prints
      // a separate fallback URL (different redirect_uri, cannot self-complete)
      // which is what the engine scrapes and sends here. Auto-opening it would
      // give the user two tabs, and the second one is the one that cannot
      // finish. The URL is still surfaced in the await_code branch as an
      // on-demand "Open sign-in page" affordance.
      case 'await_browser': {
        store.setLoginState(u.provider, { phase: 'waiting', url: u.authUrl })
        if (u.authUrl && !CLI_OPENS_OWN_BROWSER.has(u.backend)) void window.ion.openExternal(u.authUrl)
        break
      }
      case 'await_device_code':
        store.setLoginState(u.provider, { phase: 'waiting', userCode: u.userCode, verificationUrl: u.verificationUrl })
        if (u.verificationUrl) void window.ion.openExternal(u.verificationUrl)
        break
      // The provider issued a code to the user in the browser and the CLI is
      // waiting for it on stdin (claude-code, whose printed fallback URL cannot
      // self-complete). The user pastes it into the settings row, which returns
      // it via providerLoginCode. Signing in through a browser and pasting a
      // code back takes longer than the 120s started-stage budget, so the
      // timeout is re-armed to the engine's own 10-minute login ceiling rather
      // than expiring under the user mid-paste.
      case 'await_auth_code':
        store.setLoginState(u.provider, { phase: 'await_code', url: u.authUrl })
        armTimeout(u.provider, 10 * 60_000)
        break
      case 'completed':
        clearTimer(u.provider)
        store.setLoginState(u.provider, null)
        void store.fetchModels().catch((err) => rDebug('model-store', 'fetchModels after login-complete failed', { provider: u.provider, error: String(err) }))
        break
      case 'failed':
        clearTimer(u.provider)
        store.setLoginState(u.provider, { phase: 'error', error: u.loginError || 'Sign-in failed' })
        break
      case 'cancelled':
        clearTimer(u.provider)
        store.setLoginState(u.provider, null)
        break
    }
  })
}
