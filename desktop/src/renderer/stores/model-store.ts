import { create } from 'zustand'
import type { ModelEntry, ProviderEntry } from '../../shared/types-models'

interface ModelStoreState {
  models: ModelEntry[]
  providers: ProviderEntry[]
  loading: boolean
  lastFetched: number
  fetchModels: () => Promise<void>
  getAvailableModels: () => ModelEntry[]
  getModelsByProvider: () => Map<string, ModelEntry[]>
  findModel: (id: string) => ModelEntry | undefined
}

export const useModelStore = create<ModelStoreState>((set, get) => ({
  models: [],
  providers: [],
  loading: false,
  lastFetched: 0,

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
}
