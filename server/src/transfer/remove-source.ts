/**
 * transfer/remove-source — deleting the original once the destination has
 * verified its copy.
 *
 * A transfer is a move. The conversation exists on one host at a time, so
 * the last step of a successful transfer is the removal of everything the
 * source held: the conversation family's files, the tab's content file, the
 * tab record, and — when the tab had one — the worktree checkout and its
 * branch. Nothing is marked, nothing is kept read-only, nothing is left to
 * reconcile later.
 *
 * Two guards make that safe to run.
 *
 * It refuses unless the tab is mid-transfer to the environment asking
 * (`sealPending`, written by `export.ts` before a single conversation file
 * is read). A removal request that names a tab nobody is transferring is a
 * bug or a stale client, and it deletes nothing.
 *
 * And it is idempotent: a tab that is already gone answers ok. The client
 * retries this step after a dropped connection, and the honest answer to
 * "remove it" when it is not there is that it is not there.
 *
 * The worktree is retired only when the caller says the whole worktree is
 * moving AND this is the last conversation left in it. A worktree move runs
 * one conversation at a time, so retiring on the first would delete the
 * checkout the next conversation still has to package. A conversation that
 * leaves a worktree on its own never retires it: the checkout, its other
 * conversations, and any uncommitted work stay exactly where they were.
 *
 * What goes with each conversation: its files, the folder it owns (plans,
 * copied-in attachments, images), its spilled tool output, and its charts.
 * A plan it kept in a shared folder (the legacy `<dataDir>/plans`, or a
 * claude-code plan in the project) goes too: it moved with the conversation,
 * and a copy left here would go stale and collide when the conversation
 * comes back. Two things stay, and the removal logs each:
 *
 *   - a shared plan another tab here still has open, which can only be a
 *     fork made before forks owned their files;
 *   - spilled tool output such a fork still points at.
 *
 * Attached files stay: they are the user's own files, or live in the
 * content-named shared store another conversation may also use.
 *
 * Order is deliberate: the worktree first, because it is the only part that
 * can refuse, then the files, then the record. A failure part-way leaves the
 * record in place and `sealPending` set, so a retry resumes rather than
 * stranding a conversation with no tab.
 */
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { collectFamily, conversationsOwnedByOtherTabs, type FamilyResult } from './collect-family'
import { collectReferences, pathWithin } from './references'
import { parentIndex } from './parent-index'
import type { PersistedTab, PersistedTabState } from '@ion/shared/types-persistence'
import { readTabsState, writeTabsState, findTab } from './tabs-file'
import type { TransferPaths } from './paths'
import { retireWorktree as realRetireWorktree } from '../worktree/relocate'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.remove-source'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export type RemoveSourceRefusalCode = 'not_pending' | 'worktree_removal_failed'

export interface RemoveSourceArgs {
  tabId: string
  /** Must match the tab's in-flight `sealPending` target, or this refuses. */
  targetEnvironmentId: string
  paths: TransferPaths
  /**
   * True only for the last conversation of a whole-worktree move. Anything
   * else — a conversation leaving its worktree alone, or an earlier
   * conversation in a worktree move — leaves the checkout in place.
   */
  retireWorktree?: boolean
  /** Injectable for tests; the real one removes the checkout and deletes the branch. */
  retireWorktreeFn?: typeof realRetireWorktree
}

export type RemoveSourceResult =
  | { ok: true; removedConversations: string[]; removedWorktreePath: string | null; alreadyGone: boolean }
  | { ok: false; refusal: { code: RemoveSourceRefusalCode; message: string } }

export async function removeTransferredSource(args: RemoveSourceArgs): Promise<RemoveSourceResult> {
  const logFields = { tab_id: args.tabId, target_environment_id: args.targetEnvironmentId }
  const state = readTabsState(args.paths.tabsFile)
  const found = findTab(state, args.tabId)

  if (!found) {
    log('nothing to remove; the tab is already gone', { ...logFields, step: 'remove', outcome: 'already_gone' })
    return { ok: true, removedConversations: [], removedWorktreePath: null, alreadyGone: true }
  }

  const pendingTo = found.tab.sealPending?.targetEnvironmentId
  if (pendingTo !== args.targetEnvironmentId) {
    warn('refused: no transfer to this environment is in flight for the tab', { ...logFields, step: 'remove', outcome: 'not_pending', pending_to: pendingTo ?? '' })
    return { ok: false, refusal: { code: 'not_pending', message: pendingTo ? `tab is transferring to ${pendingTo}, not ${args.targetEnvironmentId}` : 'no transfer is in flight for this tab' } }
  }

  // The worktree first: it is the only step that can refuse, and refusing
  // after the conversations were deleted would leave a checkout nobody owns.
  let removedWorktreePath: string | null = null
  const worktree = found.tab.worktree
  const othersInWorktree = worktree
    ? state.tabs.filter((t) => t.id !== args.tabId && t.worktree?.worktreePath === worktree.worktreePath).length
    : 0
  if (worktree && args.retireWorktree && othersInWorktree > 0) {
    // Asked to retire a checkout other conversations still live in. Retiring
    // it would strand them; keep it and say so. The move still completes.
    warn('worktree kept: other conversations still live in it', { ...logFields, step: 'remove_worktree', outcome: 'kept', worktree_path: worktree.worktreePath, others: othersInWorktree })
  } else if (worktree && !args.retireWorktree) {
    log('worktree kept: this move takes the conversation only', { ...logFields, step: 'remove_worktree', outcome: 'kept', worktree_path: worktree.worktreePath, others: othersInWorktree })
  }
  if (worktree && args.retireWorktree && othersInWorktree === 0) {
    const retire = args.retireWorktreeFn ?? realRetireWorktree
    const result = await retire({
      repoPath: worktree.repoPath,
      worktreePath: worktree.worktreePath,
      branchName: worktree.branchName,
    })
    if (!result.ok) {
      warn('refused: the source worktree could not be removed', { ...logFields, step: 'remove_worktree', outcome: 'failed', worktree_path: worktree.worktreePath, error: result.error ?? '' })
      return { ok: false, refusal: { code: 'worktree_removal_failed', message: result.error ?? 'the source worktree could not be removed' } }
    }
    removedWorktreePath = worktree.worktreePath
    log('source worktree removed', { ...logFields, step: 'remove_worktree', outcome: 'ok', worktree_path: removedWorktreePath, branch: worktree.branchName })
  }

  const rootConversationId = found.tab.conversationId ?? found.tab.id ?? args.tabId
  // The same family the export shipped: the tab's own conversations and
  // their dispatch children. A fork, or a conversation another tab owns, was
  // never shipped and is never deleted here.
  const family = await collectFamily(rootConversationId, args.paths.conversationsDir, {
    tab: found.tab,
    ownedElsewhere: conversationsOwnedByOtherTabs(state, args.tabId),
  })
  // Worked out before anything is deleted: both read the files about to go.
  const tabContentFile = join(args.paths.tabContentDir, `${args.tabId}.json`)
  const sharedPlans = sharedPlansToRemove(args.paths, family, found.tab, tabContentFile, state, args.tabId, logFields)
  const keptToolResults = await toolResultsStillReferenced(args.paths.conversationsDir, family.ids, logFields)

  const removedConversations: string[] = []
  for (const member of family.members) {
    for (const path of member.paths) {
      rmSync(path, { force: true })
    }
    const memberDir = join(args.paths.conversationsDir, member.id)
    if (existsSync(memberDir)) rmSync(memberDir, { recursive: true, force: true })
    const toolResults = join(args.paths.conversationsDir, 'tool-results', member.id)
    if (existsSync(toolResults) && !keptToolResults.has(member.id)) rmSync(toolResults, { recursive: true, force: true })
    const charts = join(args.paths.dataDir, 'resources', member.id)
    if (existsSync(charts)) rmSync(charts, { recursive: true, force: true })
    removedConversations.push(member.id)
  }
  for (const plan of sharedPlans) rmSync(plan, { force: true })
  log('source conversation files removed', {
    ...logFields,
    step: 'remove_conversations',
    outcome: 'ok',
    root_conversation_id: rootConversationId,
    conversation_count: removedConversations.length,
    shared_plans_removed: sharedPlans.length,
    tool_results_kept: keptToolResults.size,
  })

  if (existsSync(tabContentFile)) {
    rmSync(tabContentFile, { force: true })
    log('source tab content removed', { ...logFields, step: 'remove_tab_content', outcome: 'ok' })
  }

  // The record last: while it exists, a retry can still find its way here.
  const after = readTabsState(args.paths.tabsFile)
  const stillThere = findTab(after, args.tabId)
  if (stillThere) {
    after.tabs.splice(stillThere.index, 1)
    writeTabsState(args.paths.tabsFile, after)
  }
  log('source removed', { ...logFields, step: 'remove', outcome: 'ok', conversation_count: removedConversations.length, had_worktree: !!removedWorktreePath })

  return { ok: true, removedConversations, removedWorktreePath, alreadyGone: false }
}

/**
 * Plans the family kept in a shared folder, which move with it: every plan
 * its history names outside the family's own folders, except one in another
 * conversation's own folder (that one is the other conversation's) and one
 * another tab here still has open.
 */
function sharedPlansToRemove(
  paths: TransferPaths,
  family: FamilyResult,
  tab: PersistedTab,
  tabContentFile: string,
  state: PersistedTabState,
  tabId: string,
  logFields: Record<string, unknown>,
): string[] {
  let tabContent: unknown = null
  if (existsSync(tabContentFile)) {
    try {
      tabContent = JSON.parse(readFileSync(tabContentFile, 'utf-8'))
    } catch (err) {
      warn('tab content unreadable; its plan references are not considered', { ...logFields, error: String(err) })
    }
  }
  const { references } = collectReferences({
    conversationsDir: paths.conversationsDir,
    members: family.members,
    rootConversationId: family.ids[0] ?? tabId,
    tabData: [tab, tabContent],
  })
  const openElsewhere = new Set<string>()
  for (const other of [...state.tabs, ...(state.settledHistory ?? [])]) {
    if (other.id === tabId) continue
    for (const instance of other.conversationPane?.instances ?? []) {
      if (instance.planFilePath) openElsewhere.add(instance.planFilePath)
    }
  }
  const plans: string[] = []
  for (const ref of references) {
    if (ref.kind !== 'plan') continue
    if (pathWithin(paths.conversationsDir, ref.path)) {
      log('shared plan kept: it is another conversation\'s own', { ...logFields, path: ref.path })
      continue
    }
    if (openElsewhere.has(ref.path)) {
      log('shared plan kept: another tab still has it open', { ...logFields, path: ref.path })
      continue
    }
    plans.push(ref.path)
  }
  return plans
}

/**
 * Family members whose spilled tool output a conversation outside the family
 * still points at. A fork made before forks owned their files kept its
 * parent's tool-result paths; its descendants are found through the parent
 * index, so only those few files are read.
 */
async function toolResultsStillReferenced(conversationsDir: string, familyIds: readonly string[], logFields: Record<string, unknown>): Promise<Set<string>> {
  const family = new Set(familyIds)
  const links = await parentIndex(conversationsDir)
  const kept = new Set<string>()
  for (const [id, link] of links) {
    if (family.has(id) || !link.parentId || !family.has(link.parentId)) continue
    let text = ''
    for (const suffix of ['.llm.jsonl', '.tree.jsonl']) {
      try { text += readFileSync(join(conversationsDir, id + suffix), 'utf-8') } catch { /* silent-ok: a file that is not there names nothing */ }
    }
    for (const member of familyIds) {
      const dir = join(conversationsDir, 'tool-results', member)
      if (text.includes(dir) || text.includes(JSON.stringify(dir).slice(1, -1))) {
        kept.add(member)
        log('tool results kept: a fork outside the move still points at them', { ...logFields, conversation_id: member, referenced_by: id })
      }
    }
  }
  return kept
}
