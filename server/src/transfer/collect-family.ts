/**
 * transfer/collect-family — the conversations ONE transfer moves: every
 * conversation the tab owns, plus each one's dispatch descendants.
 *
 * A tab owns more than its current conversation. A checkpoint cut moves the
 * tab onto a new conversation and keeps the earlier ones as its history
 * (`historicalSessionIds`, the instance ledger). Those are ancestors of the
 * current conversation, so walking forward from it alone left them behind:
 * the destination lost that history, and the source kept files no tab owned.
 *
 * Descendants are found through `parentId` in each `.llm.jsonl` header
 * (`parent-index.ts`). Two kinds of descendant are NOT the tab's to move:
 *
 *   - a fork (`forkOf` in its header): an independent conversation that may
 *     have its own tab, and that the transfer must never take with it;
 *   - any conversation another tab owns, open or settled. This covers forks
 *     made before the engine marked them, which carry only `parentId`.
 *
 * Neither is walked through, so a fork's own dispatch children stay with it.
 *
 * Distinct from `conversation-backup/collect-conversations.ts`'s
 * `collectExportConversations`: that one collects by tab/chain membership
 * across the WHOLE conversations directory. This collects one tab's
 * conversations, which is what a transfer needs — a conversation's dispatch
 * children are not referenced by any tabs/chains file at all.
 */
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import type { PersistedTab, PersistedTabState } from '@ion/shared/types-persistence'
import { parentIndex } from './parent-index'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('transfer.family', msg, fields)
}

const SIDE_FILE_SUFFIXES = ['.tree.jsonl', '.llm.jsonl', '.memory.md', '.dispatch-outbox.json', '.jsonl', '.json'] as const

export interface FamilyMember {
  id: string
  /** Every sidecar file present for this id (suffix set above), absolute paths. */
  paths: string[]
  /**
   * `<conversationsDir>/<id>/`, the folder the conversation owns (its plans,
   * copied-in attachments, and images), when it exists.
   */
  ownedDir: string | null
  /** `<conversationsDir>/tool-results/<id>/`, its spilled tool output, when it exists. */
  toolResultsDir: string | null
}

export interface FamilyResult {
  ids: string[]
  members: FamilyMember[]
}

function resolveMember(id: string, conversationsDir: string): FamilyMember {
  const paths: string[] = []
  for (const suffix of SIDE_FILE_SUFFIXES) {
    const path = join(conversationsDir, id + suffix)
    if (existsSync(path)) paths.push(path)
  }
  const ownedDir = join(conversationsDir, id)
  const toolResultsDir = join(conversationsDir, 'tool-results', id)
  return {
    id,
    paths,
    ownedDir: existsSync(ownedDir) ? ownedDir : null,
    toolResultsDir: existsSync(toolResultsDir) ? toolResultsDir : null,
  }
}

/**
 * Every conversation id a tab record names: its current conversation, the
 * history a checkpoint cut left behind, and each instance's ledger.
 */
export function tabConversationIds(tab: PersistedTab): string[] {
  const ids = new Set<string>()
  const add = (id: unknown): void => { if (typeof id === 'string' && id) ids.add(id) }
  add(tab.conversationId)
  add(tab.lastKnownSessionId)
  for (const id of tab.historicalSessionIds ?? []) add(id)
  for (const instance of tab.conversationPane?.instances ?? []) {
    add(instance.currentSessionId)
    for (const id of instance.conversationIds ?? []) add(id)
    for (const entry of instance.sessions ?? []) add(entry.id)
  }
  return [...ids]
}

/** Every conversation id that a tab other than `tabId` owns, open or settled. */
export function conversationsOwnedByOtherTabs(state: PersistedTabState, tabId: string): Set<string> {
  const owned = new Set<string>()
  for (const tab of [...state.tabs, ...(state.settledHistory ?? [])]) {
    if (tab.id === tabId) continue
    for (const id of tabConversationIds(tab)) owned.add(id)
  }
  return owned
}

/**
 * The conversations a transfer of `tab` moves: `rootConversationId`, every
 * conversation the tab record names that exists on disk, and each one's
 * dispatch descendants, walked to a fixed point. `ownedElsewhere` (from
 * `conversationsOwnedByOtherTabs`) and forks are excluded and not walked
 * through.
 *
 * Bounded by the number of conversation files on disk (one pass per
 * iteration, iterations bounded by chain depth) — a malformed self-referential
 * `parentId` cannot loop forever because `family` only ever grows and the
 * membership check is what drives each addition.
 */
export async function collectFamily(
  rootConversationId: string,
  conversationsDir: string,
  scope: { tab?: PersistedTab; ownedElsewhere?: ReadonlySet<string> } = {},
): Promise<FamilyResult> {
  const links = await parentIndex(conversationsDir)
  const ownedElsewhere = scope.ownedElsewhere ?? new Set<string>()

  const family = new Set<string>([rootConversationId])
  const history = scope.tab ? tabConversationIds(scope.tab) : []
  let absent = 0
  for (const id of history) {
    if (id === rootConversationId) continue
    if (!links.has(id)) { absent++; continue }
    family.add(id)
  }

  let forksLeft = 0
  let otherTabsLeft = 0
  const skipped = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const [id, link] of links) {
      if (family.has(id) || skipped.has(id)) continue
      if (!link.parentId || !family.has(link.parentId)) continue
      if (link.forkOf) { skipped.add(id); forksLeft++; continue }
      if (ownedElsewhere.has(id)) { skipped.add(id); otherTabsLeft++; continue }
      family.add(id)
      grew = true
    }
  }

  const ids = [...family]
  log('family collected', {
    root_conversation_id: rootConversationId,
    conversation_count: ids.length,
    history_count: history.length,
    history_absent: absent,
    forks_left: forksLeft,
    other_tabs_left: otherTabsLeft,
  })
  return { ids, members: ids.map((id) => resolveMember(id, conversationsDir)) }
}

/** Total on-disk bytes across every family member's files (preview/logging only). */
export function familyTotalBytes(result: FamilyResult): number {
  let total = 0
  for (const member of result.members) {
    for (const path of member.paths) {
      try {
        total += statSync(path).size
      } catch {
        // A file that vanished between resolveMember and this stat is not
        // fatal here — it is a size estimate, not the archive contents.
      }
    }
  }
  return total
}
