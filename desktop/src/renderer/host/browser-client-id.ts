const CLIENT_ID_KEY = 'ion-web-client-id'

/** A stable id for this tab, kept in `sessionStorage` so it survives a reload but not a new tab (one environment per tab — no catalog, spec 18). */
export function tabClientId(): string {
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    window.sessionStorage.setItem(CLIENT_ID_KEY, id)
    return id
  } catch {
    // Private-mode sessionStorage can throw; a fresh id per reconnect attempt is still correct, just not stable across reloads.
    return crypto.randomUUID()
  }
}
