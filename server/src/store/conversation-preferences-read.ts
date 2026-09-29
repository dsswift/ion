/**
 * The Personal preferences one conversation runs under, by tab id. For the
 * readers that hold only an id and run with no request in context: the engine
 * control plane starting a session, the early-stop responder, the titler.
 * See conversation-preferences.ts for why they read the stamp.
 *
 * The session store registers the lookup rather than being imported here:
 * the engine control plane is one of the readers, and the store's own import
 * graph reaches the control plane, so a direct import would be a cycle. Same
 * handoff as session-store-force-flush.ts.
 */
import type { PersonalPreferences } from '@ion/shared/settings-registry'
import { effectiveConversationPreferences } from '../conversation-preferences'

type StampLookup = (tabId: string) => PersonalPreferences | undefined

let lookup: StampLookup | null = null

/** Registered once by `sessionStore.ts` when the store is created. */
export function registerConversationPreferencesLookup(fn: StampLookup): void {
  lookup = fn
}

/** Registry defaults before the store exists, and for a tab it does not hold. */
export function conversationPreferencesFor(tabId: string): Required<PersonalPreferences> {
  return effectiveConversationPreferences({ conversationPreferences: lookup?.(tabId) })
}
