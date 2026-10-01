/**
 * provider-api — the provider / model / model-tier operations, headless.
 *
 * These bodies used to live inside `desktop/src/main/ipc/models.ts`,
 * `providers.ts`, and `oauth.ts`, reachable only through `ipcMain.handle`.
 * That made them Electron-only by accident rather than by nature: every one
 * of them is a validate-then-delegate call onto the engine bridge, with
 * nothing window- or Electron-specific in it. A browser Studio client
 * therefore had no way to list models, store an API key, or set a default
 * provider — the whole "AI & Models" settings category was hidden from it
 * for want of a transport, not for want of an implementation.
 *
 * They live here now so BOTH callers share one implementation: the Electron
 * IPC layer is a thin adapter over these functions, and
 * `protocol/provider-actions.ts` exposes the same functions as
 * `studio_action`s for every remote Studio client. Argument validation is
 * part of the shared function, not the adapter, so a malformed payload is
 * refused identically on both paths.
 */
import type { ModelTier } from '@ion/shared/types-model-tiers'
import { loginFlowIsHostOnly, HOST_ONLY_LOGIN_REFUSAL, type ProviderEntry } from '@ion/shared/types-models'
import { engineBridge } from '../state'
import { getDefaultProvider as bridgeGetDefaultProvider, setDefaultProvider as bridgeSetDefaultProvider } from './engine-bridge-providers'
import { updateCache, refreshModelCache } from './ipc/models'
import { wireProviderSubscriptionEvents } from './provider-subscription-api'
import { log as _log, debug as _debug } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('provider-api', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('provider-api', msg, fields)
}

export interface MutationResult {
  ok: boolean
  error?: string
}

function isModelTier(value: unknown): value is ModelTier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tier = value as Record<string, unknown>
  return typeof tier.name === 'string' && tier.name.trim() !== ''
    && typeof tier.model === 'string' && tier.model.trim() !== ''
    && Array.isArray(tier.fallbacks) && tier.fallbacks.every((fallback) => typeof fallback === 'string')
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** The full model + provider listing consumers render in a model picker. */
export async function listModels(): Promise<unknown> {
  debug('list_models')
  const result = await engineBridge.listModels()
  try {
    // Cached for remote snapshots (iOS reads the cache, not the engine).
    updateCache(result)
  } catch (err) {
    log('model_cache: update error', { error: (err as Error).message })
  }
  return result
}

export async function listModelTiers(): Promise<unknown> {
  debug('list_model_tiers')
  return engineBridge.listModelTiers()
}

export async function setModelTier(payload: unknown): Promise<MutationResult> {
  if (!isModelTier(payload)) {
    log('model_tiers: set rejected malformed payload')
    return { ok: false, error: 'set_model_tier requires name, model, and string fallbacks' }
  }
  debug('set_model_tier', { tier: payload.name, model: payload.model, fallback_count: payload.fallbacks.length })
  const result = await engineBridge.setModelTier(payload)
  if (!result.ok) log('model_tiers: set failed', { tier: payload.name, error: result.error ?? 'unknown' })
  return result
}

export async function removeModelTier(payload: unknown): Promise<MutationResult> {
  const name = (payload as { name?: unknown } | null)?.name
  if (!nonEmptyString(name)) {
    log('model_tiers: remove rejected malformed payload')
    return { ok: false, error: 'remove_model_tier requires a tier name' }
  }
  debug('remove_model_tier', { tier: name })
  const result = await engineBridge.removeModelTier(name)
  if (!result.ok) log('model_tiers: remove failed', { tier: name, error: result.error ?? 'unknown' })
  return result
}

export async function resolveModelTier(tier: unknown): Promise<unknown> {
  const name = typeof tier === 'string' ? tier : ''
  debug('model_tier_resolve', { tier: name })
  try {
    return await engineBridge.resolveModelTier(name)
  } catch (err) {
    log('model_tier: resolve failed', { tier: name, error: (err as Error).message })
    // Unreachable engine reads as unconfigured: the gated feature refuses
    // with its remediation message rather than proceeding on a guess.
    return { tier: name, model: name, fallbacks: [], configured: false }
  }
}

export async function getDefaultProvider(): Promise<string> {
  debug('get_default_provider')
  const provider = await bridgeGetDefaultProvider(engineBridge)
  debug('default_provider: snapshot read', { provider, configured: provider !== '' })
  return provider
}

export async function setDefaultProvider(payload: unknown): Promise<MutationResult> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  if (typeof provider !== 'string') {
    log('default_provider: set rejected malformed payload')
    return { ok: false, error: 'set_default_provider requires a provider string' }
  }
  debug('set_default_provider', { provider, cleared: provider === '' })
  const result = await bridgeSetDefaultProvider(engineBridge, provider)
  if (!result.ok) log('default_provider: set failed', { provider, error: result.error ?? 'unknown' })
  else log('default_provider: set', { provider, cleared: provider === '' })
  return result
}

/**
 * Store a provider credential, or clear it: an empty credential is the
 * explicit "remove this key" instruction. The value is bearer-grade, so only
 * its presence is ever logged — never the value, and never its length
 * alongside the provider name in a way that would narrow it.
 */
export async function storeCredential(payload: unknown): Promise<MutationResult> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  const credential = (payload as { credential?: unknown } | null)?.credential
  if (!nonEmptyString(provider) || typeof credential !== 'string') {
    log('store_credential rejected: malformed input')
    return { ok: false, error: 'a provider and a credential string are required' }
  }
  log('store_credential', { provider, cleared: credential === '' })
  const result = await engineBridge.storeCredential(provider, credential)
  if (result.ok) {
    // Auth status changed — the engine runs discovery for this provider,
    // so the cache is refreshed after a delay to pick up the new models.
    setTimeout(() => { void refreshModelCache() }, 2000)
  }
  return result
}

export async function refreshModels(payload: unknown): Promise<MutationResult> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  const target = typeof provider === 'string' && provider !== '' ? provider : undefined
  log('refresh_models', { provider: target ?? 'all' })
  const result = await engineBridge.refreshModels(target)
  if (result.ok) {
    setTimeout(() => { void refreshModelCache() }, 1000)
  }
  return result
}

/**
 * Start a delegated-CLI sign-in. `onHost` says whether the requester runs on
 * this server's host. A requester elsewhere is refused a flow the engine
 * reports as host-only (the CLI's own browser with a loopback callback
 * here), because nothing it opens could ever reach that listener. Paste-code
 * and device-code flows finish from anywhere and start as usual.
 */
export async function providerLogin(payload: unknown, onHost: boolean): Promise<unknown> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  if (!nonEmptyString(provider)) return { ok: false, error: 'provider is required' }
  if (!onHost) {
    const listing = await engineBridge.listModels()
    const entry = (listing.providers as ProviderEntry[] | undefined)?.find((p) => p.id === provider)
    if (loginFlowIsHostOnly(entry?.loginFlow)) {
      log('provider_login refused: host-only flow requested off the host', { provider, login_flow: entry?.loginFlow ?? '' })
      return { ok: false, error: HOST_ONLY_LOGIN_REFUSAL }
    }
    log('provider_login allowed off the host', { provider, login_flow: entry?.loginFlow ?? '(none)' })
  }
  log('provider_login', { provider, on_host: onHost })
  return engineBridge.providerLogin(provider)
}

export async function providerLoginCancel(payload: unknown): Promise<unknown> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  if (!nonEmptyString(provider)) return { ok: false, error: 'provider is required' }
  log('provider_login_cancel', { provider })
  return engineBridge.providerLoginCancel(provider)
}

/**
 * Return a browser-issued authorization code to a login parked on the
 * await_auth_code stage (claude-code). The code is a bearer-grade secret, so
 * only its length is logged, never its value.
 */
export async function providerLoginCode(payload: unknown): Promise<unknown> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  const code = (payload as { code?: unknown } | null)?.code
  if (!nonEmptyString(provider) || !nonEmptyString(code)) {
    log('provider_login_code rejected: malformed input', { has_code: nonEmptyString(code) })
    return { ok: false, error: 'provider and code are required' }
  }
  log('provider_login_code', { provider, code_length: code.trim().length })
  return engineBridge.providerLoginCode(provider, code.trim())
}

export async function providerLogout(payload: unknown): Promise<unknown> {
  const provider = (payload as { provider?: unknown } | null)?.provider
  if (!nonEmptyString(provider)) return { ok: false, error: 'provider is required' }
  log('provider_logout', { provider })
  return engineBridge.providerLogout(provider)
}

/**
 * Translate the engine's provider/model snapshots into client-facing
 * channel signals.
 *
 * This wiring used to live inside `desktop/src/main/ipc/models.ts`, which
 * meant it ran ONLY in the Electron main process: the standalone server
 * never emitted `ion:model-tiers-updated` or `ion:default-provider-updated`
 * at all, so a browser client's settings panel would never learn that a tier
 * or the default provider had changed underneath it.
 *
 * `emit` is the sink because the two hosts fan out differently — the server
 * publishes a `studio_event` to every attached client, the Electron main
 * process sends to its own windows — while the DECISION (which engine event
 * means which channel) is identical and belongs in one place.
 *
 * Each signal carries the engine's complete snapshot as its payload. A
 * client may apply it instead of re-reading: the engine answers every
 * `list_model_tiers` with this same event, so a client that re-read on every
 * signal would read forever.
 */
export function wireProviderEvents(emit: (channel: string, payload: unknown) => void): void {
  engineBridge.on('event', (_key: string, event: { type?: string; modelTiers?: ModelTier[]; defaultProvider?: string }) => {
    if (event.type === 'engine_model_tiers') {
      log('model_tiers: snapshot received', { count: event.modelTiers?.length ?? 0 })
      emit('ion:model-tiers-updated', { modelTiers: event.modelTiers ?? [] })
      return
    }
    if (event.type === 'engine_default_provider') {
      log('default_provider: snapshot received', { provider: event.defaultProvider ?? '' })
      emit('ion:default-provider-updated', { defaultProvider: event.defaultProvider ?? '' })
    }
  })

  wireProviderSubscriptionEvents(engineBridge, emit)

  engineBridge.on('reconnected', () => {
    log('engine reconnected; refreshing the model cache')
    void refreshModelCache()
  })

  // Initial fetch once the bridge has had a moment to connect.
  setTimeout(() => { void refreshModelCache() }, 2000)
}
