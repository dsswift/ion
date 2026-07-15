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

export async function providerLogout(bridge: EngineBridge, provider: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  return bridge._sendWithResult({ cmd: 'provider_logout', provider })
}
