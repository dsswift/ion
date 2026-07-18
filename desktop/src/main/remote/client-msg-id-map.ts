// Desktop-local clientMsgId ↔ canonical-entry-id map (RC-9).
//
// The engine is UI-agnostic and persists no client-supplied id on a turn — as it
// should: optimistic-bubble reconciliation is a UI concern no headless consumer
// needs. But an iOS client inserts an optimistic user bubble keyed by the
// clientMsgId it sent, then must collapse it against the canonical user row when
// history loads. The live re-key signals (user_turn_persisted / message_end
// userEntryId) can be dropped on a transport switch; when they are, iOS has no
// key on the persisted row to reconcile against and renders the user turn twice
// (the second copy below the assistant reply).
//
// This map lives entirely in the desktop remote layer — the desktop already
// knows BOTH sides: it minted the echo id from cmd.clientMsgId, and it observes
// the canonical entry id the engine reports for that turn. We record
// entryId → clientMsgId here, then annotate the outgoing history user row with
// clientMsgId when serving desktop_load_conversation / the rewind broadcast, so
// iOS can reconcile by the id it originally sent. No engine change; the field is
// a desktop↔iOS wire addition only.
//
// Bounded: per-tab LRU (MAX_PER_TAB entries) so a long conversation cannot grow
// it without limit, and cleared on tab close. entryIds are canonical engine
// tree-entry ids (globally unique), so per-tab scoping is for cleanup, not
// correctness.

/** Max recorded turns per tab. A history page is ~10 turns; well above it. */
const MAX_PER_TAB = 200

/** tabId → (canonical user entryId → the clientMsgId that produced it). */
const byTab = new Map<string, Map<string, string>>()

/**
 * Record that the canonical user entry `entryId` was produced by the turn the
 * client submitted as `clientMsgId`. No-op when either is empty, or when the
 * clientMsgId is a desktop-minted fallback (`remote-…`/`remote-engine-…`) that
 * no client optimistically inserted — recording those would waste the LRU on
 * ids nothing reconciles against.
 */
export function recordClientMsgId(tabId: string, entryId: string | undefined, clientMsgId: string | null | undefined): void {
  if (!tabId || !entryId || !clientMsgId) return
  // Desktop-minted fallbacks are not client optimistic ids; skip them.
  if (clientMsgId.startsWith('remote-')) return
  let m = byTab.get(tabId)
  if (!m) {
    m = new Map()
    byTab.set(tabId, m)
  }
  // Refresh LRU position: delete + re-set moves it to the end of iteration order.
  if (m.has(entryId)) m.delete(entryId)
  m.set(entryId, clientMsgId)
  // Evict the oldest entries past the cap (Map preserves insertion order).
  while (m.size > MAX_PER_TAB) {
    const oldest = m.keys().next().value
    if (oldest === undefined) break
    m.delete(oldest)
  }
}

/** Look up the clientMsgId for a canonical user entry id, or undefined. */
export function lookupClientMsgId(tabId: string, entryId: string | undefined): string | undefined {
  if (!tabId || !entryId) return undefined
  return byTab.get(tabId)?.get(entryId)
}

/** Drop all recorded ids for a tab (called on tab close). */
export function clearClientMsgIdsForTab(tabId: string): void {
  byTab.delete(tabId)
}

/** Test-only: wipe all state. */
export function __resetClientMsgIdMapForTest(): void {
  byTab.clear()
}
