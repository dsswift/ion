// FR-02: who is connected to this environment and which tab they have
// focused. Broadcast on the `studio:presence` channel (environment scope --
// every connection, full snapshot every change) and carried on
// `StudioSnapshot.presence` for first paint. Shared by the server
// (protocol/presence.ts), the desktop/browser presence store, and iOS.

export interface PresenceEntry {
  subject: string
  displayName: string
  focusedTabId: string | null
}

// `driving` maps a tabId to the subject whose `submitRemotePrompt` started
// its still-running turn -- a different dimension than `focusedTabId` (which
// tab a connection is looking at), so it rides alongside `entries` rather
// than folding into one.
export interface PresenceSnapshot {
  entries: PresenceEntry[]
  driving: Record<string, string>
}
