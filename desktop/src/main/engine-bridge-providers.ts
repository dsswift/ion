/**
 * Model, credential, and delegated-CLI provider RPC helpers for the engine
 * bridge. Extracted from engine-bridge.ts to stay under the 600-line file-size
 * cap; the thin wrappers in engine-bridge.ts delegate here directly.
 */
import type { EngineBridge } from './engine-bridge'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('engine-bridge', msg, fields)
}

export async function listModels(bridge: EngineBridge): Promise<{ models: any[]; providers: any[] }> {
  await bridge.connect()
  const result = await bridge._sendWithData<{ models: any[]; providers: any[] }>({ cmd: 'list_models' })
  return result.data || { models: [], providers: [] }
}

/**
 * Resolve a model tier from ~/.ion/models.json to its configured chain.
 * `configured=false` means the tier is not defined — the engine echoes an
 * unknown name back, and consumers gating features on a tier existing (the
 * conflict assist requires `standard`) need that fact, not the echo.
 */
export async function resolveModelTier(bridge: EngineBridge, tier: string): Promise<{
  tier: string; model: string; fallbacks: string[]; configured: boolean
}> {
  await bridge.connect()
  const result = await bridge._sendWithData<{ tier: string; model: string; fallbacks: string[]; configured: boolean }>(
    { cmd: 'resolve_model_tier', text: tier },
  )
  return result.data ?? { tier, model: tier, fallbacks: [], configured: false }
}

export async function storeCredential(bridge: EngineBridge, provider: string, credential: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  return bridge._sendWithResult({ cmd: 'store_credential', provider, credential })
}

export async function refreshModels(bridge: EngineBridge, provider?: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  const msg: Record<string, unknown> = { cmd: 'refresh_models' }
  if (provider) msg.provider = provider
  return bridge._sendWithResult(msg)
}

export async function providerLogin(bridge: EngineBridge, provider: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  log('provider_login', { provider })
  return bridge._sendWithResult({ cmd: 'provider_login', provider })
}

export async function providerLoginCancel(bridge: EngineBridge, provider: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  return bridge._sendWithResult({ cmd: 'provider_login_cancel', provider })
}

// providerLoginCode returns a browser-issued authorization code to a login
// parked on the await_auth_code stage. The code rides in `text` per the engine's
// provider_login_code contract; only its length is logged.
export async function providerLoginCode(bridge: EngineBridge, provider: string, code: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  log('provider_login_code', { provider, codeLength: code.length })
  return bridge._sendWithResult({ cmd: 'provider_login_code', provider, text: code })
}

export async function providerLogout(bridge: EngineBridge, provider: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  return bridge._sendWithResult({ cmd: 'provider_logout', provider })
}
