import { create } from 'zustand'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'

/** Live state of an in-flight delegated-CLI login, keyed by provider id. */
export interface ProviderLoginState {
  phase: 'waiting' | 'error'
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
      set({
        models: result.models || [],
        providers: result.providers || [],
        lastFetched: Date.now(),
        loading: false,
      })
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
 * Call once from app initialization to set up background model sync.
 * - Fetches models immediately
 * - Refreshes periodically (every 5 minutes)
 * - Listens for main-process cache updates (engine reconnect, credential changes)
 */
export function setupModelSync(): void {
  // Initial fetch
  useModelStore.getState().fetchModels()

  // Periodic refresh
  setInterval(() => {
    useModelStore.getState().fetchModels()
  }, MODEL_REFRESH_INTERVAL)

  // Listen for main process model cache updates
  window.ion.on('ion:models-updated', () => {
    useModelStore.getState().fetchModels()
  })

  // Delegated-CLI (codex/grok/cursor) login lifecycle. Each stage updates the
  // per-provider login state the settings UI renders; terminal stages clear it.
  const loginTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearTimer = (provider: string) => {
    const t = loginTimers.get(provider)
    if (t) { clearTimeout(t); loginTimers.delete(provider) }
  }
  window.ion.onProviderLoginEvent((u) => {
    const store = useModelStore.getState()
    switch (u.stage) {
      case 'started':
        store.setLoginState(u.provider, { phase: 'waiting' })
        clearTimer(u.provider)
        loginTimers.set(u.provider, setTimeout(() => {
          useModelStore.getState().setLoginState(u.provider, { phase: 'error', error: 'Sign-in timed out' })
          void window.ion.providerLoginCancel(u.provider)
        }, 120_000))
        break
      case 'await_browser':
        store.setLoginState(u.provider, { phase: 'waiting', url: u.authUrl })
        if (u.authUrl) void window.ion.openExternal(u.authUrl)
        break
      case 'await_device_code':
        store.setLoginState(u.provider, { phase: 'waiting', userCode: u.userCode, verificationUrl: u.verificationUrl })
        if (u.verificationUrl) void window.ion.openExternal(u.verificationUrl)
        break
      case 'completed':
        clearTimer(u.provider)
        store.setLoginState(u.provider, null)
        store.fetchModels()
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
