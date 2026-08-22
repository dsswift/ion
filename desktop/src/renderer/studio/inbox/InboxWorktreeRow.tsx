import React, { useState } from 'react'
import { CaretDown, CaretRight, GitBranch } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { WorktreeRowMenu } from '../../components/WorktreeRowMenu'
import { WorktreeStateSlot } from '../../components/WorktreeStateSlot'
import { WorktreeEnrollmentSlot } from '../../components/WorktreeEnrollmentSlot'
import { resolveRowState, resolveRowWords } from '../../components/worktreeRowState'
import { findActiveAutoFix } from '../../stores/slices/conflict-assist-dedupe'
import { ConflictsDialog } from '../../components/git/ConflictsDialog'
import { BenchConflictDialog } from '../../components/git/BenchConflictDialog'
import { BenchVerificationDialog } from '../../components/git/BenchVerificationDialog'
import { useColors } from '../../theme'
import { rError, rInfo } from '../../rendererLogger'
import { operationIsPending, operationMessage, pipelineIsRunning, useBenchOperation, useWorktreeOperation, useWorktreePipeline } from './worktreeOperationSelectors'
import type { InboxNavigatorGroup } from './inbox-navigator'

/** One enriched, collapsible worktree GROUP HEADER. Conversation rows belong below it. */
export function InboxWorktreeRow({
  repoPath, group, expanded, onToggle, onOpen, onSync, onUpdatePin, onToggleMembership,
}: {
  repoPath: string
  group: InboxNavigatorGroup
  expanded: boolean
  onToggle(): void
  onOpen(): void
  onSync(worktreePath: string, sourceBranch: string): void
  onUpdatePin(worktreePath: string, sourceBranch: string): void
  /** Request enroll/disenroll. The list owns the call so it can refresh its cache once it settles. */
  onToggleMembership(worktreePath: string, sourceBranch: string, enrolled: boolean): void
}): React.JSX.Element {
  const colors = useColors()
  const entry = group.worktree!
  const tabs = useSessionStore((state) => state.tabs)
  const workspaces = useSessionStore((state) => state.benchWorkspaces.get(repoPath) ?? [])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [conflicts, setConflicts] = useState<string | null>(null)
  const [benchConflict, setBenchConflict] = useState(false)
  const [verification, setVerification] = useState(false)
  // Resolved the same way `membership` is: a direct member-scan first, and
  // when that misses but `group.membership` still carries a fallback value
  // (computed upstream against the ACTIVE bench selection, not every bench a
  // worktree could belong to — see inbox-navigator.ts's `buildWorktreeList`
  // call), a second lookup by source branch. Without this second step the
  // state slot could show "pin behind" (from `group.membership`) while
  // `workspace` stayed undefined, so Update Pin silently did nothing: the
  // click handler's `if (!workspace) return` fired with no membership match
  // to explain why. Keeping ONE resolution here, rather than a per-consumer
  // fallback, is what stops that gap from reopening in the bench-conflict and
  // verification dialogs, which read this same `workspace` variable.
  const workspace = workspaces.find((candidate) => candidate.members.some((member) => member.worktreePath === entry.worktreePath))
    ?? (group.membership && entry.sourceBranch
      ? workspaces.find((candidate) => candidate.sourceBranch === entry.sourceBranch)
      : undefined)
  const membership = workspace?.members.find((member) => member.worktreePath === entry.worktreePath) ?? group.membership
  const worktreeOperation = useWorktreeOperation(entry.worktreePath)
  const benchOperation = useBenchOperation(repoPath, workspace?.sourceBranch)
  const pipeline = useWorktreePipeline(repoPath)
  const syncing = (operationIsPending(worktreeOperation) && (worktreeOperation?.action === 'syncWorktree' || worktreeOperation?.kind === 'sync')) || pipelineIsRunning(pipeline)
  const updatingPin = operationIsPending(worktreeOperation) && (worktreeOperation?.action === 'benchUpdateMember' || worktreeOperation?.kind === 'update-pin')
  const pinUpdateLocked = operationIsPending(benchOperation) && !updatingPin
  const controlMessage = operationMessage(worktreeOperation) ?? operationMessage(benchOperation)
  const activeWorktreeResolver = findActiveAutoFix(tabs, entry.worktreePath)
  const activeBenchResolver = workspace ? findActiveAutoFix(tabs, workspace.benchPath) : null
  const verificationSuspect = workspace?.lastAssemblyFailure === 'verification'
    && workspace.lastAssemblyVerification?.replayedBranches.includes(entry.branchName)
    ? { command: workspace.lastAssemblyVerification.command }
    : undefined
  const rowState = resolveRowState({ entry, membership, syncing, verificationSuspect, hasActiveResolver: activeBenchResolver !== null })
  const words = resolveRowWords({ entry, membership, syncing, verificationSuspect }).join(' · ')
  const enrolled = !!membership

  const sync = (): void => {
    if (!entry.sourceBranch) {
      rError('inbox.worktree', 'sync refused because source branch is missing', {
        branch: entry.branchName,
        worktree_path: entry.worktreePath,
      })
      return
    }
    onSync(entry.worktreePath, entry.sourceBranch)
  }
  const updatePin = (): void => {
    if (!workspace) {
      rError('inbox.worktree', 'pin update refused because no bench workspace resolved', {
        branch: entry.branchName,
        worktree_path: entry.worktreePath,
        source_branch: entry.sourceBranch ?? '',
      })
      return
    }
    if (pinUpdateLocked) {
      rInfo('inbox.worktree', 'pin update refused because another update is in flight', {
        branch: entry.branchName,
        worktree_path: entry.worktreePath,
      })
      return
    }
    onUpdatePin(entry.worktreePath, workspace.sourceBranch)
  }

  const toggleMembership = (): void => {
    if (workspace && membership) {
      onToggleMembership(entry.worktreePath, workspace.sourceBranch, true)
      return
    }
    if (!entry.sourceBranch) {
      rError('inbox.worktree', 'add to bench refused because source branch is missing', {
        branch: entry.branchName,
        worktree_path: entry.worktreePath,
      })
      return
    }
    onToggleMembership(entry.worktreePath, entry.sourceBranch, false)
  }

  return <>
    <div
      data-testid={`inbox-worktree-header-${entry.branchName}`}
      aria-busy={operationIsPending(worktreeOperation) || operationIsPending(benchOperation)}
      data-operation-message={controlMessage}
      onClick={onOpen}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }) }}
      style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 'calc(100% - 20px)', margin: '5px 10px 2px', padding: '5px 8px', border: `1px solid ${colors.containerBorder}`, borderRadius: 5, background: colors.containerBg, color: colors.textSecondary, cursor: 'pointer', fontSize: 11 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <button onClick={(event) => { event.stopPropagation(); onToggle() }} aria-label={`Toggle ${group.label}`} style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', padding: 0 }}>{expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}</button>
        <WorktreeEnrollmentSlot enrolled={enrolled} order={membership ? (workspace?.members.findIndex((member) => member.worktreePath === entry.worktreePath) ?? -1) + 1 : undefined} railStarts={false} railContinues={false} branchName={entry.branchName} width={14} pending={operationIsPending(worktreeOperation) || operationIsPending(benchOperation)} pendingMessage={controlMessage} onToggleMembership={toggleMembership} />
        {entry.isDirty && <strong style={{ color: colors.worktreeDirty }}>!</strong>}
        {entry.unlandedCommitCount > 0 && <span style={{ color: colors.unlandedCount, fontSize: 9 }}>{entry.unlandedCommitCount}↑</span>}
        <WorktreeStateSlot state={rowState} branchName={entry.branchName} hasActiveWorktreeResolver={activeWorktreeResolver !== null} onFocusActiveWorktreeResolver={() => { if (activeWorktreeResolver) useSessionStore.getState().selectTab(activeWorktreeResolver) }} onResolve={() => setConflicts(entry.worktreePath)} onSync={sync} updatingPin={updatingPin} pinUpdateLocked={pinUpdateLocked} onUpdatePin={updatePin} onShowBenchConflict={() => setBenchConflict(true)} onFocusActiveResolver={() => { if (activeBenchResolver) useSessionStore.getState().selectTab(activeBenchResolver) }} onShowVerificationFailure={() => setVerification(true)} />
        <GitBranch size={13} color={colors.accent} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{group.label}</span>
        <span style={{ color: colors.textTertiary, fontSize: 10 }}>{group.tabs.length}</span>
      </div>
      <div style={{ display: 'flex', gap: 5, paddingLeft: 18, minWidth: 0, fontSize: 9, color: colors.textTertiary }}>
        <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>{entry.label}</span>
        <span>·</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{words || entry.lastCommitSubject || 'no commits yet'}</span>
      </div>
    </div>
    {menu && <WorktreeRowMenu entry={entry} repoPath={repoPath} anchor={menu} onClose={() => setMenu(null)} onRefresh={() => void useSessionStore.getState().refreshWorkspaceViews(repoPath)} />}
    {conflicts && <ConflictsDialog directory={conflicts} onClose={() => setConflicts(null)} />}
    {benchConflict && workspace && membership && <BenchConflictDialog repoPath={repoPath} sourceBranch={workspace.sourceBranch} member={membership} onClose={() => setBenchConflict(false)} onResolveReady={(benchPath) => { setBenchConflict(false); setConflicts(benchPath) }} />}
    {verification && workspace && <BenchVerificationDialog repoPath={repoPath} workspace={workspace} onClose={() => setVerification(false)} />}
  </>
}
