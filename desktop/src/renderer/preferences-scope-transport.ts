/**
 * Where a preference is kept depends on its scope
 * (`@ion/shared/settings-registry`).
 *
 * A Personal preference and a Device setting belong to this client, so they
 * are kept on it: `desktop.json` in Electron, IndexedDB in a browser
 * (`host.deviceSettings()`). They are never written to a server. An
 * Environment or Account setting belongs to a server and goes there.
 *
 * Both halves used to go to the local server. That wrote the theme and the
 * fonts twice, and it made a Personal preference something a server held a
 * copy of, which is the copy that went stale.
 */
import { settingScope } from '@ion/shared/settings-registry'
import { host } from './host/host-instance'
import { rError, rInfo } from './rendererLogger'

/** True for a key this client keeps itself. An unknown key is not the client's: it goes to the server, as it always did. */
export function isClientOwnedSetting(key: string): boolean {
  const scope = settingScope(key)
  return scope === 'personal' || scope === 'device'
}

export function partitionByOwner(patch: Record<string, unknown>): { client: Record<string, unknown>; server: Record<string, unknown> } {
  const client: Record<string, unknown> = {}
  const server: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (isClientOwnedSetting(key)) client[key] = value
    else server[key] = value
  }
  return { client, server }
}

/** Keep client-owned keys on this client. One write per key: the host API is per key. */
export function saveClientSettings(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    void host.setDeviceSetting(key, value)
      .catch((err) => rError('preferences', 'device setting not persisted', { key, error: String(err) }))
  }
}

/** Set in the client store once the earlier server-held values have been carried over. */
export const CLIENT_SETTINGS_ADOPTED_KEY = 'clientSettingsAdopted'

/**
 * The document the preference store hydrates from: the server's settings for
 * what a server owns, this client's own store for what the client owns.
 *
 * Client-owned keys lived on the local server before they moved here. The
 * first load after the upgrade ADOPTS them: every client-owned value the
 * server document holds is written to the client store, and a marker records
 * that it happened. This is what carries a person's theme, fonts, and
 * personal preferences across. After that the client's value always wins and
 * the server's old copy is never read again.
 *
 * Adoption is decided by the marker, never by whether the client store
 * already has the key: that store answers with shipped defaults for keys it
 * has never been given, and a default is not a value someone chose.
 */
export async function mergeClientSettings(serverSettings: Record<string, unknown>): Promise<Record<string, unknown>> {
  let local: Record<string, unknown> = {}
  try {
    local = await host.deviceSettings()
  } catch (err) {
    rError('preferences', 'device settings unreadable; client-owned preferences fall back to earlier values', { error: String(err) })
  }
  const adopting = local[CLIENT_SETTINGS_ADOPTED_KEY] !== true
  const merged: Record<string, unknown> = {}
  const adopted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(serverSettings)) {
    if (!isClientOwnedSetting(key)) merged[key] = value
    else if (adopting) { merged[key] = value; adopted[key] = value }
  }
  for (const [key, value] of Object.entries(local)) {
    if (isClientOwnedSetting(key) && !(key in adopted)) merged[key] = value
  }
  if (adopting) {
    rInfo('preferences', 'adopted earlier server-held preferences onto this client', { keys: Object.keys(adopted) })
    saveClientSettings({ ...adopted, [CLIENT_SETTINGS_ADOPTED_KEY]: true })
  }
  return merged
}
