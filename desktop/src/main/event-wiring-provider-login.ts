/**
 * engine_provider_login handling, extracted from event-wiring.ts (file-size
 * cap). Forwards each login stage to the renderer and refreshes the model cache
 * when a login completes so the provider flips to authed.
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
