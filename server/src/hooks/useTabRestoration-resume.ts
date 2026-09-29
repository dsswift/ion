import type { PersistedTab, PersistedConversationInstance } from '@ion/shared/types-persistence'
import { deriveLedger, ledgerIds } from '@ion/shared/session-ledger'
import { resolveRestoreSessionId } from './useTabRestoration-engine'

/**
 * Resolve the conversation id a restored extension tab should resume, probing
 * each candidate for a backing file so phantoms (ids pre-minted on a prior
 * restart, never saved) are never selected.
 *
 * The session LEDGER is the durable source: `currentSessionId` is the live id,
 * and the ledger entries are the full chain. Restore PREFERS `currentSessionId`
 * (when it has a backing file) so a restart resumes the SAME session and appends
 * nothing — the structural fix for restart-fragmentation. Legacy files with no
 * ledger fall back to the conversationIds chain / tab id / lastKnownSessionId
 * via resolveRestoreSessionId.
 *
 * Phantom guard (#230/#231): a fileless candidate is never returned; if every
 * candidate is unprobeable, returns '' and the caller's refuse-guard protects
 * history. Extracted from useTabRestoration-engine.ts to keep that file under
 * the 600-line cap.
 */
export async function resolveResumeSessionId(
  inst: PersistedConversationInstance,
  st: PersistedTab,
  conversationExists: (id: string) => Promise<boolean>,
): Promise<string> {
  const persistedLedger = deriveLedger(inst)
  const candidateIds = Array.from(
    new Set(
      [
        inst.currentSessionId ?? '',
        ...ledgerIds(persistedLedger),
        ...(inst.conversationIds ?? []),
        st.conversationId ?? '',
        st.lastKnownSessionId ?? '',
      ].filter(Boolean) as string[],
    ),
  )

  const existing = new Set<string>()
  await Promise.all(
    candidateIds.map(async (id) => {
      try {
        if (await conversationExists(id)) existing.add(id)
      } catch {
        // Probe failure is treated as "unknown" → not added to the existing
        // set. resolveRestoreSessionId will skip it; if every candidate is
        // unprobeable the caller's refuse-guard still protects history.
      }
    }),
  )

  // Prefer currentSessionId when it has a backing file (the durable ledger
  // resume target); otherwise fall back to the priority walk over the chain /
  // tab id / lastKnownSessionId.
  if (inst.currentSessionId && existing.has(inst.currentSessionId)) {
    return inst.currentSessionId
  }
  return resolveRestoreSessionId(inst, st, (id) => existing.has(id))
}
