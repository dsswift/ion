/**
 * The `liveResolvedModel` half of the tabs sync: tab id → instance id → the
 * model that instance runs on, from the one resolver (model-resolution.ts).
 *
 * Every instance gets an entry, including one that resolves to nothing: an
 * empty string tells the client "the server has no model for this", which is
 * different from "the server has not said yet".
 */
import type { ConversationPane, TabState } from '@ion/shared/types'
import { tabHasExtensions } from '@ion/shared/tab-predicates'
import { accountModelDefaults, resolveConversationModel, type AccountModelDefaults } from '../model-resolution'

export type ResolvedModelMap = Record<string, Record<string, string>>

export function projectResolvedModels(
  tabs: readonly TabState[],
  conversationPanes: ReadonlyMap<string, ConversationPane>,
): ResolvedModelMap {
  // One settings read per owner per publish, not one per conversation.
  const defaultsByOwner = new Map<string, AccountModelDefaults>()
  const out: ResolvedModelMap = {}
  for (const tab of tabs) {
    const owner = tab.principalSubject ?? ''
    let defaults = defaultsByOwner.get(owner)
    if (!defaults) {
      defaults = accountModelDefaults(tab.principalSubject)
      defaultsByOwner.set(owner, defaults)
    }
    const harnessGoverned = tabHasExtensions(tab)
    const byInstance: Record<string, string> = {}
    for (const inst of conversationPanes.get(tab.id)?.instances ?? []) {
      byInstance[inst.id] = resolveConversationModel(inst, harnessGoverned, defaults).model
    }
    out[tab.id] = byInstance
  }
  return out
}
