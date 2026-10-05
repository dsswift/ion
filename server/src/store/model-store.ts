import { create } from 'zustand'
import type { ModelEntry, ProviderEntry } from '@ion/shared/types-models'
import { isDelegatedCliBackend, loginFlowIsHostOnly, HOST_ONLY_LOGIN_REFUSAL } from '@ion/shared/types-models'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { rDebug, rWarn } from './rendererLogger'
import { listModels, on, onProviderLoginEvent, openExternal, providerLoginCancel } from './host-api'

/** Live state of an in-flight delegated-CLI login, keyed by provider id. */
export interface ProviderLoginState {
  phase: 'waiting' | 'await_code' | 'error'
  url?: string
  userCode?: string
  verificationUrl?: string
  error?: string
}

/** One Environment's model catalog: what its engine reports for its providers. */
export interface EnvironmentModels {
  models: ModelEntry[]
  providers: ProviderEntry[]
  loading: boolean
  lastFetched: number
}

const EMPTY_ENVIRONMENT: EnvironmentModels = { models: [], providers: [], loading: false, lastFetched: 0 }

export interface ModelStoreState {
  /**
   * The local Environment's catalog lives in these four top-level fields,
   * where every reader that means "this server" (and every test that seeds
   * state) has always found it.
   */
  models: ModelEntry[]
  providers: ProviderEntry[]
  loading: boolean
  lastFetched: number
  /**
   * Every OTHER Environment's catalog, keyed by environment id (ADR-033
   * union store). The desktop shows every paired server's conversations at
   * once, and a Devbox tab's model picker must list DEVBOX's models, not the
   * laptop's; Settings -> Providers stores a key on whichever Environment
   * its selector names. Read through `environmentModels()` so the local
   * slice and the remote slices have one selector. The server process
   * itself only ever holds the local slice.
   */
  byEnvironment: Record<string, EnvironmentModels>
  /** In-flight delegated-CLI logins, by environment id then provider id. */
  loginStates: Record<string, Record<string, ProviderLoginState>>
  /**
   * Whether this client runs on each Environment's own host, as that
   * server reported it on `studio_welcome.onHost`. Decides whether a sign-in
   * that finishes through a loopback callback on the host can finish here.
   * Absent until the Environment's welcome arrives, which reads as not on
   * the host.
   */
  onHost: Record<string, boolean>
  setEnvironmentOnHost: (environmentId: string, onHost: boolean) => void
  /** Fetches the local Environment's catalog. */
  fetchModels: () => Promise<void>
  /** Fetches one Environment's catalog; concurrent calls for the same Environment coalesce. */
  fetchModelsFor: (environmentId: string) => Promise<void>
  setLoginState: (environmentId: string, provider: string, state: ProviderLoginState | null) => void
  loginStateFor: (environmentId: string, provider: string) => ProviderLoginState | undefined
  environment: (environmentId: string) => EnvironmentModels
  modelsFor: (environmentId: string) => ModelEntry[]
  providersFor: (environmentId: string) => ProviderEntry[]
  getAvailableModels: () => ModelEntry[]
  getModelsByProvider: () => Map<string, ModelEntry[]>
  findModel: (id: string) => ModelEntry | undefined
  findModelIn: (environmentId: string, id: string) => ModelEntry | undefined
  /**
   * True when this model currently routes to a delegated CLI. Derived from the
   * provider entry the engine populates from the same routing helper a run
   * uses, so what the UI states is what the next run will actually do.
   */
  isModelCliServed: (id: string) => boolean
  isModelCliServedIn: (environmentId: string, id: string) => boolean
}

/** The last local slice handed out, reused while its four fields are unchanged. */
let localSlice: EnvironmentModels = EMPTY_ENVIRONMENT

/**
 * One Environment's catalog out of the store state: the top-level fields
 * for local, the keyed slice for a remote Environment, an empty slice for
 * one nothing has fetched yet. Works as a zustand selector body: the result
 * keeps its identity until one of its fields changes. Stock zustand 5
 * compares a selector's result by identity, so a fresh local wrapper on
 * every call re-renders its component until React gives up (error #185).
 */
export function environmentModels(state: Pick<ModelStoreState, 'models' | 'providers' | 'loading' | 'lastFetched' | 'byEnvironment'>, environmentId: string): EnvironmentModels {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    if (localSlice.models !== state.models || localSlice.providers !== state.providers || localSlice.loading !== state.loading || localSlice.lastFetched !== state.lastFetched) {
      localSlice = { models: state.models, providers: state.providers, loading: state.loading, lastFetched: state.lastFetched }
    }
    return localSlice
  }
  return state.byEnvironment[environmentId] ?? EMPTY_ENVIRONMENT
}

type LocalModelsListener = (models: ModelEntry[]) => void
const localModelsListeners = new Set<LocalModelsListener>()

/**
 * Runs `listener` with the local Environment's models after every successful
 * fetch. The store only fetches; what a fresh catalog means for saved
 * preferences is up to the client that owns them. Returns the unsubscribe.
 */
export function onLocalModelsFetched(listener: LocalModelsListener): () => void {
  localModelsListeners.add(listener)
  return () => { localModelsListeners.delete(listener) }
}

export const useModelStore = create<ModelStoreState>((set, get) => {
  const patchEnvironment = (environmentId: string, patch: Partial<EnvironmentModels>): void => {
    set((s) => {
      if (environmentId === LOCAL_ENVIRONMENT_ID) return patch
      const next = { ...(s.byEnvironment[environmentId] ?? EMPTY_ENVIRONMENT), ...patch }
      return { byEnvironment: { ...s.byEnvironment, [environmentId]: next } }
    })
  }

  return {
    byEnvironment: {},
    models: [],
    providers: [],
    loading: false,
    lastFetched: 0,
    loginStates: {},
    onHost: {},

    setEnvironmentOnHost: (environmentId, onHost) => {
      if (get().onHost[environmentId] === onHost) return
      rDebug('model-store', 'environment host placement recorded', { environment_id: environmentId, on_host: onHost })
      set((s) => ({ onHost: { ...s.onHost, [environmentId]: onHost } }))
    },

    setLoginState: (environmentId, provider, state) =>
      set((s) => {
        const env = { ...(s.loginStates[environmentId] ?? {}) }
        if (state === null) delete env[provider]
        else env[provider] = state
        return { loginStates: { ...s.loginStates, [environmentId]: env } }
      }),

    loginStateFor: (environmentId, provider) => get().loginStates[environmentId]?.[provider],

    environment: (environmentId) => environmentModels(get(), environmentId),
    modelsFor: (environmentId) => get().environment(environmentId).models,
    providersFor: (environmentId) => get().environment(environmentId).providers,

    fetchModels: () => get().fetchModelsFor(LOCAL_ENVIRONMENT_ID),

    fetchModelsFor: async (environmentId) => {
      if (get().environment(environmentId).loading) return
      patchEnvironment(environmentId, { loading: true })
      try {
        const result = await listModels(environmentId)
        const models = result.models || []
        patchEnvironment(environmentId, { models, providers: result.providers || [], lastFetched: Date.now(), loading: false })
        rDebug('model-store', 'models fetched', { environment_id: environmentId, model_count: models.length, provider_count: (result.providers || []).length })
        // Preferences name local models only.
        if (environmentId === LOCAL_ENVIRONMENT_ID) {
          for (const listener of localModelsListeners) {
            try {
              listener(models)
            } catch (err) {
              rWarn('model-store', 'local models listener failed', { error: String(err) })
            }
          }
        }
      } catch (err) {
        rDebug('model-store', 'fetchModels failed', { environment_id: environmentId, error: String(err) })
        patchEnvironment(environmentId, { loading: false })
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

    isModelCliServed: (id) => get().isModelCliServedIn(LOCAL_ENVIRONMENT_ID, id),
    isModelCliServedIn: (environmentId, id) => {
      if (!id) return false
      const env = get().environment(environmentId)
      const providerId = env.models.find((m) => m.id === id)?.providerId
      if (!providerId) return false
      return isDelegatedCliBackend(env.providers.find((p) => p.id === providerId)?.backend)
    },
    findModel: (id) => get().findModelIn(LOCAL_ENVIRONMENT_ID, id),
    findModelIn: (environmentId, id) => get().environment(environmentId).models.find((m) => m.id === id),
  }
})

const MODEL_REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

/**
 * Delegated-CLI backends whose binary opens its own browser during login.
 * For these the engine's await_browser URL is the CLI's printed *fallback*
 * (a different redirect_uri that cannot self-complete), so auto-opening it
 * would produce a second, dead-end tab. Surfaced on demand instead.
 */
const CLI_OPENS_OWN_BROWSER = new Set(['claude-code'])

/**
 * What an off-host client's sign-in is told when the CLI opened a
 * loopback-callback browser on the environment's host: opening that URL here
 * would send the callback to this machine, where nothing is listening.
 */
export const REMOTE_BROWSER_LOGIN_REFUSAL = HOST_ONLY_LOGIN_REFUSAL

/**
 * Call once from app initialization to set up background model sync.
 * - Fetches models immediately
 * - Refreshes periodically (every 5 minutes)
 * - Listens for main-process cache updates (engine reconnect, credential changes)
 */
let initialModelSync: Promise<void> | null = null

export function setupModelSyncReady(): Promise<void> {
  if (initialModelSync) return initialModelSync
  initialModelSync = useModelStore.getState().fetchModels()
  return initialModelSync
}

export function setupModelSync(): void {
  // Initial fetch
  void setupModelSyncReady().catch((err) => rDebug('model-store', 'initial fetchModels failed', { error: String(err) }))

  // Periodic refresh of local plus every remote Environment fetched so far,
  // so a remote catalog does not go stale once something has looked at it.
  setInterval(() => {
    for (const environmentId of [LOCAL_ENVIRONMENT_ID, ...Object.keys(useModelStore.getState().byEnvironment)]) {
      void useModelStore.getState().fetchModelsFor(environmentId).catch((err) => rDebug('model-store', 'periodic fetchModels failed', { environment_id: environmentId, error: String(err) }))
    }
  }, MODEL_REFRESH_INTERVAL)

  // A server's model cache changed (engine reconnect, credential stored):
  // refetch THAT server. The renderer's host-api passes the Environment the
  // signal came from; the server process only ever hears about itself.
  on('ion:models-updated', (environmentId?: unknown) => {
    const target = typeof environmentId === 'string' && environmentId ? environmentId : LOCAL_ENVIRONMENT_ID
    void useModelStore.getState().fetchModelsFor(target).catch((err) => rDebug('model-store', 'fetchModels on cache-update failed', { environment_id: target, error: String(err) }))
  })

  // Delegated-CLI (codex/claude-code/grok/cursor) login lifecycle. Each stage
  // updates the per-provider login state the settings UI renders; terminal
  // stages clear it. Keyed by the Environment the event came from.
  const loginTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const timerKey = (environmentId: string, provider: string): string => `${environmentId} ${provider}`
  const clearTimer = (environmentId: string, provider: string) => {
    const t = loginTimers.get(timerKey(environmentId, provider))
    if (t) { clearTimeout(t); loginTimers.delete(timerKey(environmentId, provider)) }
  }
  // Abandon an in-flight login after `ms` so a browser flow the user never
  // finishes cannot leave the row spinning (and leaks no engine-side login).
  const armTimeout = (environmentId: string, provider: string, ms: number) => {
    clearTimer(environmentId, provider)
    loginTimers.set(timerKey(environmentId, provider), setTimeout(() => {
      useModelStore.getState().setLoginState(environmentId, provider, { phase: 'error', error: 'Sign-in timed out' })
      void providerLoginCancel(provider, environmentId)
    }, ms))
  }
  onProviderLoginEvent((u, environmentId?: unknown) => {
    const envId = typeof environmentId === 'string' && environmentId ? environmentId : LOCAL_ENVIRONMENT_ID
    const store = useModelStore.getState()
    switch (u.stage) {
      case 'started':
        store.setLoginState(envId, u.provider, { phase: 'waiting' })
        armTimeout(envId, u.provider, 120_000)
        break
      // await_browser carries a URL for the consumer to open — EXCEPT for a
      // driver whose CLI already opened its own browser. claude-code does: it
      // starts a loopback callback server and opens that tab itself, then prints
      // a separate fallback URL (different redirect_uri, cannot self-complete)
      // which is what the engine scrapes and sends here. Auto-opening it would
      // give the user two tabs, and the second one is the one that cannot
      // finish. The URL is still surfaced in the await_code branch as an
      // on-demand "Open sign-in page" affordance.
      //
      // For a client that is not on the environment's host the same URL is
      // worse than useless for a callback flow: the CLI's loopback listener
      // is on the host, so a tab opened here can never reach it. The login is
      // abandoned with a message instead of a dead tab. claude-code's
      // pasted-code path still works from anywhere (the code goes back over
      // the wire), so it proceeds.
      case 'await_browser': {
        if (store.onHost[envId] !== true && !CLI_OPENS_OWN_BROWSER.has(u.backend)) {
          rDebug('model-store', 'off-host browser-callback login refused', { environment_id: envId, provider: u.provider, backend: u.backend })
          clearTimer(envId, u.provider)
          store.setLoginState(envId, u.provider, { phase: 'error', error: REMOTE_BROWSER_LOGIN_REFUSAL })
          void providerLoginCancel(u.provider, envId)
          break
        }
        store.setLoginState(envId, u.provider, { phase: 'waiting', url: u.authUrl })
        if (u.authUrl && !CLI_OPENS_OWN_BROWSER.has(u.backend)) void openExternal(u.authUrl)
        break
      }
      case 'await_device_code':
        store.setLoginState(envId, u.provider, { phase: 'waiting', userCode: u.userCode, verificationUrl: u.verificationUrl })
        if (u.verificationUrl) void openExternal(u.verificationUrl)
        break
      // The provider can issue a fallback code for stdin after the CLI has
      // opened its own loopback-callback browser tab. The user can paste that
      // code into the settings row through providerLoginCode. The CLI can also
      // finish directly through the loopback callback; the engine observes the
      // child exit and sends completed. A manual paste can take longer than the
      // 120s started-stage budget, so the timeout is re-armed to the engine's
      // own 10-minute login ceiling rather than expiring under the user.
      case 'await_auth_code': {
        // The page that issues the code: named on this stage, or kept from
        // await_browser when the engine named it only there.
        const url = u.authUrl || store.loginStateFor(envId, u.provider)?.url
        store.setLoginState(envId, u.provider, { phase: 'await_code', url })
        // The CLI opened its own tab on the host. A client anywhere else has
        // no tab, so the page is opened here for the code to be read from.
        if (url && store.onHost[envId] !== true) void openExternal(url)
        armTimeout(envId, u.provider, 10 * 60_000)
        break
      }
      case 'completed':
        clearTimer(envId, u.provider)
        store.setLoginState(envId, u.provider, null)
        void store.fetchModelsFor(envId).catch((err) => rDebug('model-store', 'fetchModels after login-complete failed', { environment_id: envId, provider: u.provider, error: String(err) }))
        break
      case 'failed':
        clearTimer(envId, u.provider)
        store.setLoginState(envId, u.provider, { phase: 'error', error: u.loginError || 'Sign-in failed' })
        break
      case 'cancelled':
        clearTimer(envId, u.provider)
        store.setLoginState(envId, u.provider, null)
        break
    }
  })
}

/** Whether a delegated-CLI sign-in for `provider` can be started at all from a client that is (or is not) on the environment's host. */
export function canStartProviderLogin(onHost: boolean, provider: Pick<ProviderEntry, 'loginFlow'>): boolean {
  if (onHost) return true
  return !loginFlowIsHostOnly(provider.loginFlow)
}
