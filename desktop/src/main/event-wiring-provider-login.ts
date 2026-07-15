/**
 * Provider-auth engine event handling, extracted from event-wiring.ts (file-size
 * cap). Covers engine_provider_login (per-stage login lifecycle) and
 * engine_providers_updated (advisory refresh nudge). Both refresh the model
 * cache so the picker and the CLI sign-in/out controls reflect current auth.
 */
import { IPC } from '../shared/types'
import { broadcast } from './broadcast'
import { refreshModelCache } from './ipc/models'

/**
 * Handle an engine_provider_login event. Returns true when the event was a
 * provider-login event (and fully handled), so the caller can return early.
 */
export function handleProviderLoginEvent(event: { type: string; providerLogin?: { stage?: string } }): boolean {
  if (event.type !== 'engine_provider_login' || !event.providerLogin) return false
  broadcast(IPC.PROVIDER_LOGIN_EVENT, event.providerLogin)
  if (event.providerLogin.stage === 'completed') {
    void refreshModelCache()
  }
  return true
}

/**
 * Handle an engine_providers_updated event: an advisory nudge that provider
 * auth / model state changed (login, logout, refresh_models, startup probe).
 * Re-pulls the model cache so the picker and the CLI sign-in/out controls
 * reflect the new state. This is the only refresh signal a completed logout
 * emits. Returns true when the event was handled.
 */
export function handleProvidersUpdatedEvent(event: { type: string }): boolean {
  if (event.type !== 'engine_providers_updated') return false
  void refreshModelCache()
  return true
}
