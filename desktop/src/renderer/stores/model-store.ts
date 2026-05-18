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
