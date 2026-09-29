/**
 * declare-preferences — tells each connected server the Personal preferences
 * it needs from this client.
 *
 * A Personal preference (`@ion/shared/settings-registry`) is yours on every
 * server, so it lives here, on the client, and no server keeps a settings
 * copy. The few a server consumes (the mode and thinking level a new
 * conversation starts at, AI titles, `.claude` compatibility, early-stop
 * continuation) are declared once per connection, on its welcome, and again
 * whenever one changes. A window that attaches after a connection's welcome
 * is handed that welcome again (`Broker.replayWelcome`), so this one path
 * covers the local Environment too. The server holds them for the life of the connection
 * and stamps them onto each conversation this client creates or prompts.
 *
 * The same values go to every server: that is what makes them Personal
 * rather than an Account setting.
 */
import { TRAVELLING_PREFERENCE_KEYS, sanitizePersonalPreferences, type PersonalPreferences } from '@ion/shared/settings-registry'
import { host, action } from '../../host/host-instance'
import { usePreferencesStore } from '../../preferences'
import { rInfo, rWarn } from '../../rendererLogger'

/** This client's travelling preferences, read from its own preference store. */
export function currentPersonalPreferences(): PersonalPreferences {
  const state = usePreferencesStore.getState() as unknown as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of TRAVELLING_PREFERENCE_KEYS) picked[key] = state[key]
  return sanitizePersonalPreferences(picked)
}

function declareTo(environmentId: string, preferences: PersonalPreferences): void {
  action(environmentId, 'preferences.declare', [preferences])
    .then(() => rInfo('declare-preferences', 'declared', { environment_id: environmentId, ...preferences }))
    .catch((err) => rWarn('declare-preferences', 'declare failed; this server will use defaults until the next one', { environment_id: environmentId, error: String(err) }))
}

/** Wire the declaration to every environment's welcome and to local changes. Returns the unsubscribe. */
export function initPreferenceDeclaration(): () => void {
  const welcomed = new Set<string>()
  let last = JSON.stringify(currentPersonalPreferences())

  const offFrame = host.onFrame((environmentId, frame) => {
    if (frame.type !== 'studio_welcome') return
    // Every welcome, not only the first: a reconnect is a new connection, and
    // the server kept nothing from the old one.
    welcomed.add(environmentId)
    declareTo(environmentId, currentPersonalPreferences())
  })
  const offStore = usePreferencesStore.subscribe(() => {
    const preferences = currentPersonalPreferences()
    const next = JSON.stringify(preferences)
    if (next === last) return
    last = next
    for (const environmentId of welcomed) declareTo(environmentId, preferences)
  })
  return () => { offFrame(); offStore() }
}
