/**
 * Remote worktree + bench handlers (iOS → desktop).
 *
 * iOS cannot see the git panel and the desktop's renderer store, so these
 * handlers read the same main-process sources the desktop UI reads and push a
 * projected state back. One owner, three renderers: the desktop overlay, the
 * Studio mirror, and iOS all render main-process truth, so the pin/staleness
 * vocabulary cannot drift between them.
 *
 * Verb results come back as a typed `desktop_worktree_op_result` rather than
 * being inferred from a state diff, so iOS can distinguish "refused, you can
 * fix this" from "failed" and say which.
 */
import { state } from '../../state'
import { broadcast } from '../../broadcast'
import { log as _log, warn as _warn } from '../../logger'
import { getWorktreeInventory } from '../../worktree/inventory-service'
import { resolveInventoryAlias } from '../../worktree/inventory-cache'
import { syncWorktreeFromSource, landAndRetireWorktree } from '../../worktree/integrate'
import { syncAllWorktrees } from '../../worktree/sync-all'
import {
  listWorkspaces, assembleWorkspace, updateMember, updateAllStale,
  addMember, removeMember,
  refreshStaleness, sourceBranchTip,
} from '../../integration/bench-ops'
import { setWorktreeStage, lookupWorktreeRegistration } from '../../worktree/registry'
import { readWorktreeBranchDefault } from '../../persistence/settings-store'
import { worktreeEphemeralDefault } from '../../worktree/worktree-choice'
import { workStageDescriptor } from '@ion/shared/types-git'
import {
  collectAllDirConversations,
  collectDirConversations,
  pickBenchConversation,
  pickDirTerminal,
  benchTerminalTitle,
  type DirConversation,
  type DirConversationSource,
} from '@ion/shared/worktree-conversations'
import { isValidProjectPath } from '../../ipc-validation'
import { projectWorktreeMembership } from './worktree-membership'
import { handleWorktreeStoreCommand } from './worktree-store-commands'
import { replaceWorktreeState } from './worktree-state-cache'
import type { RemoteCommand, RemoteWorktreeState, RemoteWorktree, RemoteBench, RemoteMembership } from '../protocol'
import type { IntegrationWorkspace } from '@ion/shared/types'
import { sendRemoteEvent } from '../../thin-view/remote-out'

const TAG = 'remote.worktree'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * The tabs the desktop currently holds, plus the per-directory conversation
 * collector built over them.
 *
 * iOS needs two different answers from one snapshot: which conversations are
 * open in each directory (so it can focus one instead of duplicating, and can
 * say WHICH conversations a worktree holds), and which terminal belongs to a
 * bench. Both derive from the same tab list, so it is read once and returned
 * alongside the collector rather than fetched twice.
 *
 * Uses `collectDirConversations` for ordinary worktree display and its
 * role-inclusive twin for benches. A machine auto-fix is shared bench work and
 * must reach iOS, while worktree rows retain operator-only display semantics.
 */
async function readTabsForProjection(): Promise<{
  tabs: Array<DirConversationSource & { inputLocked?: boolean; inboxState?: 'active' | 'snoozed' | 'settled' }>
  openIn: (dir: string) => DirConversation[]
  openAllIn: (dir: string) => DirConversation[]
}> {
  let tabs: Array<DirConversationSource & { inputLocked?: boolean; inboxState?: 'active' | 'snoozed' | 'settled' }> = []
  try {
    const { getRemoteTabStates } = await import('../snapshot')
    const snapshot = await getRemoteTabStates()
    tabs = snapshot.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      customTitle: t.customTitle ?? null,
      status: t.status,
      workingDirectory: t.workingDirectory ?? '',
      // Carried so a terminal is never counted as a conversation, and so the
      // bench terminal can be resolved at all.
      isTerminalOnly: t.isTerminalOnly ?? false,
      // Role + lock resolve the persistent singleton and distinguish
      // machine work in the role-inclusive bench projection.
      tabRole: t.tabRole ?? null,
      inputLocked: t.inputLocked ?? false,
      // A settled tab may exist briefly as a read-only review preview after
      // the operator opens it from history. It is not an active conversation
      // and must not inflate the worktree row's open count on iOS.
      inboxState: t.inboxState,
    }))
  } catch (err) {
    // Losing this costs the "already open" hint, the conversation names, and the
    // bench terminal id — never correctness of the worktree state itself.
    warn('could not resolve open conversations', { error: String(err) })
  }
  return {
    tabs,
    openIn: (dir: string) => collectDirConversations(tabs.filter((tab) => tab.inboxState !== 'settled'), dir),
    openAllIn: (dir: string) => collectAllDirConversations(tabs.filter((tab) => tab.inboxState !== 'settled'), dir),
  }
}

/**
 * Build the per-repo worktree + bench projection for iOS.
 *
 * One worktree yields ONE wire record, with its bench membership attached when
 * it has one. The bench used to re-send every member as a separate
 * `RemoteBenchMember` carrying its own copy of the worktree's path, branch, and
 * label -- so an enrolled worktree crossed the wire twice and iOS rendered it in
 * two sections with two vocabularies.
 */
export async function buildWorktreeState(repoPath: string): Promise<RemoteWorktreeState> {
  const { tabs, openIn, openAllIn } = await readTabsForProjection()
  // Through the service so an iOS refresh rides the same cached crawl the
  // desktop panels just ran instead of starting a competing one.
  const inventory = await getWorktreeInventory(repoPath)
  // The inventory crawl learns every checkout alias. Resolve only after it
  // returns, so this projection, its workspace lookups, and the wire state use
  // the source repo identity even when iOS requested from a worktree or bench.
  const sourceRepoPath = resolveInventoryAlias(repoPath)

  // Staleness is refreshed BEFORE the join so the memberships attached below are
  // the current ones, not the values from the last build.
  const workspaces: IntegrationWorkspace[] = []
  for (const ws of listWorkspaces(sourceRepoPath)) {
    workspaces.push((await refreshStaleness(sourceRepoPath, ws.sourceBranch)) ?? ws)
  }

  // Membership by worktree path, with its merge position. Array order IS merge
  // order, so the index is read here rather than stored on the record.
  const membershipOf = new Map<string, RemoteMembership>()
  for (const ws of workspaces) {
    ws.members.forEach((m, i) => {
      membershipOf.set(m.worktreePath, projectWorktreeMembership(m, ws.sourceBranch, i + 1))
    })
  }

  // Projected field by field rather than spread: `conflictedPaths` is a
  // desktop-only field (only the desktop can resolve conflicts, so only it has
  // a surface for the paths), and a spread would ship the array to a client
  // that reads nothing but the count. iOS gets `conflictedCount` — the number
  // its row badge actually renders.
  const worktrees: RemoteWorktree[] = inventory.map((w) => ({
    worktreePath: w.worktreePath,
    branchName: w.branchName,
    label: w.label,
    title: w.title,
    sourceBranch: w.sourceBranch,
    head: w.head,
    lastCommitSubject: w.lastCommitSubject,
    isDirty: w.isDirty,
    unlandedCommitCount: w.unlandedCommitCount,
    needsSync: w.needsSync,
    safeToDiscard: w.safeToDiscard,
    landedAt: w.landedAt,
    stage: w.stage,
    provisionState: w.provisionState,
    provisionError: w.provisionError,
    ephemeral: w.ephemeral,
    ephemeralKeptReason: w.ephemeralKeptReason,
    operationState: w.operationState,
    conflictedCount: w.conflictedPaths?.length,
    openConversations: openIn(w.worktreePath),
    membership: membershipOf.get(w.worktreePath),
  }))

  const benches: RemoteBench[] = []
  for (const ws of workspaces) {
    const tip = await sourceBranchTip(sourceRepoPath, ws.sourceBranch)
    // Derived from the tab's own state, never stored: absent means no terminal
    // is open for this bench, which is what lets iOS say "Open" vs "Go to".
    const terminal = pickDirTerminal(tabs, ws.benchPath, benchTerminalTitle(ws.sourceBranch))
    // The persistent operator conversation, resolved by stored role. Only a
    // role-tagged tab is projected (adopted: false); a legacy candidate is NOT
    // projected as the singleton — adoption is an owner-store decision made at
    // open time, and projecting a tab the store has not adopted would let iOS
    // navigate to a conversation that the next desktop open might not choose.
    const conversation = pickBenchConversation(tabs, ws.benchPath)
    benches.push({
      repoPath: ws.repoPath,
      sourceBranch: ws.sourceBranch,
      benchPath: ws.benchPath,
      benchBranch: ws.benchBranch,
      baseSha: ws.baseSha,
      lastBuiltAt: ws.lastBuiltAt,
      lastAssembly: ws.lastAssembly,
      lastAssemblyError: ws.lastAssemblyError,
      lastAssemblyFailure: ws.lastAssemblyFailure,
      resolutionOpen: ws.resolutionOpen,
      // Trimmed projection: `diagnosticTreeAt` is desktop-local state (whether
      // the AI-assisted analysis has materialised the failing tree back into
      // the bench) that iOS has no verb to act on and no use for.
      lastAssemblyVerification: ws.lastAssemblyVerification && {
        command: ws.lastAssemblyVerification.command,
        outputTail: ws.lastAssemblyVerification.outputTail,
        replayedBranches: ws.lastAssemblyVerification.replayedBranches,
      },
      baseDrifted: !!tip && !!ws.baseSha && tip !== ws.baseSha,
      // A bench is shared integration work: include its machine auto-fix and
      // analysis conversations so iOS can name and navigate them. Worktree
      // records above remain operator-only through openIn().
      openConversations: openAllIn(ws.benchPath),
      benchConversationTabId: conversation && !conversation.adopted ? conversation.tab.id : undefined,
      benchTerminalTabId: terminal?.id,
    })
  }

  // The operator's recorded default source branch for this repo, keyed by the
  // canonical source-repo path exactly as the desktop renderer reads it. When
  // set, iOS creates a worktree conversation directly with this branch instead
  // of prompting; when absent, iOS falls back to the branch picker.
  const defaultSourceBranch = readWorktreeBranchDefault(sourceRepoPath)
  // What a worktree conversation here is when the create does not say: the
  // project's remembered choice, else `.ion/worktree.json`. iOS preselects
  // its Ephemeral switch from it.
  const ephemeralDefault = worktreeEphemeralDefault(sourceRepoPath).ephemeral

  return { repoPath: sourceRepoPath, worktrees, benches, defaultSourceBranch, ephemeralDefault }
}

/**
 * Push the current worktree + bench state for a repo to iOS.
 *
 * Exported because the titling path renames a worktree outside any iOS command
 * and must push the new name; without that the phone shows the slug until its
 * next manual refresh.
 */
export async function pushWorktreeState(repoPath: string): Promise<void> {
  const stateForRepo = await buildWorktreeState(repoPath)
  const sourceRepoPath = stateForRepo.repoPath
  replaceWorktreeState(state.remoteWorktreeStates, stateForRepo)
  sendRemoteEvent({ type: 'desktop_worktree_state', states: [stateForRepo] })
  log('pushed worktree state', {
    repo_path: sourceRepoPath,
    requested_repo_path: repoPath,
    canonicalized: sourceRepoPath !== repoPath,
    worktrees: stateForRepo.worktrees.length,
    benches: stateForRepo.benches.length,
  })
}

function sendResult(
  operation: 'open' | 'sync' | 'land_and_retire' | 'assemble' | 'update' | 'update_all' | 'sync_all' | 'retire' | 'create' | 'convert' | 'rename' | 'reprovision' | 'recover_conflict' | 'conflict_assist' | 'analyse_verification' | 'discard_recordings' | 'pipeline_start',
  result: {
    ok: boolean; error?: string; tabId?: string; refusedDirty?: boolean; hasConflicts?: boolean; warning?: string
    recoveryRef?: string; prunedBenchPaths?: string[]
  },
  summary?: string,
): void {
  sendRemoteEvent({
    type: 'desktop_worktree_op_result',
    operation,
    ok: result.ok,
    error: result.error,
    tabId: result.tabId,
    refusedDirty: result.refusedDirty,
    hasConflicts: result.hasConflicts,
    warning: result.warning,
    summary,
    recoveryRef: result.recoveryRef,
    prunedBenchPaths: result.prunedBenchPaths?.length ? result.prunedBenchPaths : undefined,
  })
}

export async function handleWorktreeCommand(cmd: RemoteCommand): Promise<boolean> {
  switch (cmd.type) {
    case 'desktop_worktree_refresh':
      await pushWorktreeState(cmd.repoPath)
      return true

    case 'desktop_worktree_open_conversation': {
      const registration = lookupWorktreeRegistration(cmd.worktreePath)
      if (registration?.landedAt) {
        warn('open worktree conversation refused: worktree has landed', {
          worktree_path: cmd.worktreePath,
          new_conversation: !!cmd.newConversation,
        })
        sendResult('open', { ok: false, error: 'This worktree has landed and is sealed for review.' })
        await pushWorktreeState(registration.repoPath)
        return true
      }
      return handleWorktreeStoreCommand(cmd)
    }

    case 'desktop_worktree_sync': {
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('sync refused: invalid path', { worktree_path: cmd.worktreePath })
        sendResult('sync', { ok: false, error: 'Invalid path.' })
        return true
      }
      const result = await syncWorktreeFromSource(cmd.worktreePath, cmd.sourceBranch)
      sendResult('sync', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_worktree_sync_all': {
      // The mechanical pass only — the desktop's AI escalation never runs from
      // here (see the wire comment in protocol-worktree.ts). The summary is
      // worded HERE so every client renders the same sentence.
      const result = await syncAllWorktrees(cmd.repoPath)
      const s = result.summary
      const parts: string[] = []
      if (s.synced > 0) parts.push(`${s.synced} synced`)
      if (s.replayed > 0) parts.push(`${s.replayed} completed by replay`)
      if (s.conflicted > 0) parts.push(`${s.conflicted} conflicted`)
      if (s.skippedDirty > 0) parts.push(`${s.skippedDirty} skipped (dirty)`)
      if (s.skippedUnknownSource > 0) parts.push(`${s.skippedUnknownSource} skipped (unknown source)`)
      if (s.failed > 0) parts.push(`${s.failed} failed`)
      const summary = parts.length > 0 ? parts.join(', ') : 'All worktrees already current'
      sendResult('sync_all', {
        ok: result.ok && s.failed === 0,
        hasConflicts: s.conflicted > 0 || undefined,
        error: result.error,
      }, summary)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_worktree_land_and_retire': {
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('land-and-retire refused: invalid path', { worktree_path: cmd.worktreePath })
        sendResult('land_and_retire', { ok: false, error: 'Invalid path.' })
        return true
      }
      const result = await landAndRetireWorktree({
        repoPath: cmd.repoPath,
        worktreePath: cmd.worktreePath,
        worktreeBranch: cmd.worktreeBranch,
        branchName: cmd.worktreeBranch,
        sourceBranch: cmd.sourceBranch,
      })
      if (result.ok) {
        broadcast('ion:worktree-landed', {
          repoPath: cmd.repoPath,
          worktreePath: cmd.worktreePath,
          prunedBenchPaths: result.prunedBenchPaths ?? [],
        })
      }
      sendResult('land_and_retire', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_assemble': {
      const result = await assembleWorkspace(cmd.repoPath, cmd.sourceBranch)
      sendResult('assemble', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_update_member': {
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('update member refused: invalid path', { worktree_path: cmd.worktreePath })
        sendResult('update', { ok: false, error: 'Invalid path.' })
        return true
      }
      const result = await updateMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath)
      sendResult('update', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_update_all': {
      const result = await updateAllStale(cmd.repoPath, cmd.sourceBranch)
      sendResult('update_all', result)
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_worktree_set_stage':
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('set stage refused: invalid path', { worktree_path: cmd.worktreePath })
        sendResult('update', { ok: false, error: 'Invalid path.' })
        return true
      }
      if (cmd.stage !== null && !workStageDescriptor(cmd.stage)) {
        warn('stage command refused: unknown value', {
          worktree_path: cmd.worktreePath, stage: String(cmd.stage),
        })
        sendResult('update', { ok: false, error: 'Unknown work stage.' })
        return true
      }
      if (!setWorktreeStage(cmd.worktreePath, cmd.stage, { repoPath: cmd.repoPath })) {
        warn('remote stage set failed to persist', { worktree_path: cmd.worktreePath, stage: cmd.stage ?? 'none' })
        sendResult('update', { ok: false, error: 'Could not save the registry.' })
        return true
      }
      await pushWorktreeState(cmd.repoPath)
      return true

    case 'desktop_bench_add_member': {
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('add member refused: invalid path', { worktree_path: cmd.worktreePath })
        return true
      }
      const result = await addMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.branchName)
      if (!result.ok) warn('add member refused', { branch: cmd.branchName, error: result.error ?? '' })
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_bench_remove_member':
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('remove member refused: invalid path', { worktree_path: cmd.worktreePath })
        return true
      }
      await removeMember(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath)
      await pushWorktreeState(cmd.repoPath)
      return true

    default:
      // Every verb that is a store action: create, rename, retire, the assist
      // chains, the pipeline, the bench opens.
      return handleWorktreeStoreCommand(cmd)
  }
}
