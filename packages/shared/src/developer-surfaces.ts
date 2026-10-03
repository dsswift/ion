/**
 * Developer surfaces: the source-control and repository features an
 * organization can switch off.
 *
 * Two policies name them, and they answer different questions:
 *
 *   - Environment policy, `customFields['ion-server'].developerSurfaces`:
 *     what this server offers. The server refuses a disabled surface's
 *     actions and withholds its events for EVERY connection, and tells each
 *     client which surfaces it offers so the client shows no control for one
 *     it does not.
 *   - Device policy, `customFields['ion-desktop'].developerSurfaces`: what
 *     this managed desktop shows. It is read from the local Environment only
 *     and applies to that desktop, whichever server a conversation is on.
 *
 * A surface is on unless a policy says `"disabled"`, so absent configuration
 * changes nothing.
 */
import type { EnterprisePolicy } from './types-enterprise'
import type { StudioWorktreeSnapshot } from './types-studio'

export const DEVELOPER_SURFACES = ['sourceControl', 'commitGraph', 'repositoryStatus', 'worktrees'] as const

export type DeveloperSurface = (typeof DEVELOPER_SURFACES)[number]

/** Whether each surface is available. */
export type DeveloperSurfaceState = Record<DeveloperSurface, boolean>

/** The configured form: each surface is `"enabled"` or `"disabled"`. */
export type DeveloperSurfacesConfig = Partial<Record<DeveloperSurface, 'enabled' | 'disabled'>>

export const ALL_DEVELOPER_SURFACES_ENABLED: DeveloperSurfaceState = {
  sourceControl: true,
  commitGraph: true,
  repositoryStatus: true,
  worktrees: true,
}

/** Reads a configured `developerSurfaces` object. Anything but `"disabled"` leaves a surface on. */
export function parseDeveloperSurfaces(raw: unknown): DeveloperSurfaceState {
  const state = { ...ALL_DEVELOPER_SURFACES_ENABLED }
  if (!raw || typeof raw !== 'object') return state
  const config = raw as Record<string, unknown>
  for (const surface of DEVELOPER_SURFACES) {
    if (config[surface] === 'disabled') state[surface] = false
  }
  return state
}

function namespaceSurfaces(policy: EnterprisePolicy | null | undefined, namespace: 'ion-server' | 'ion-desktop'): DeveloperSurfaceState {
  const fields = policy?.customFields?.[namespace]
  if (!fields || typeof fields !== 'object') return { ...ALL_DEVELOPER_SURFACES_ENABLED }
  return parseDeveloperSurfaces((fields as Record<string, unknown>).developerSurfaces)
}

/** The surfaces this Environment's server offers to every connection. */
export function deriveEnvironmentDeveloperSurfaces(policy: EnterprisePolicy | null | undefined): DeveloperSurfaceState {
  return namespaceSurfaces(policy, 'ion-server')
}

/** The surfaces a managed desktop shows. Pass the LOCAL Environment's policy only. */
export function deriveDeviceDeveloperSurfaces(policy: EnterprisePolicy | null | undefined): DeveloperSurfaceState {
  return namespaceSurfaces(policy, 'ion-desktop')
}

/** A surface is available only where both states have it on. */
export function intersectDeveloperSurfaces(a: DeveloperSurfaceState, b: DeveloperSurfaceState): DeveloperSurfaceState {
  return {
    sourceControl: a.sourceControl && b.sourceControl,
    commitGraph: a.commitGraph && b.commitGraph,
    repositoryStatus: a.repositoryStatus && b.repositoryStatus,
    worktrees: a.worktrees && b.worktrees,
  }
}

/** Whether any surface that reads live repository state is on. With none, nothing subscribes to a repository. */
export function repositoryFeedOffered(state: DeveloperSurfaceState): boolean {
  return state.sourceControl || state.commitGraph || state.repositoryStatus
}

/** Wire-decode guard for a `DeveloperSurfaceState`. */
export function isDeveloperSurfaceState(value: unknown): value is DeveloperSurfaceState {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return DEVELOPER_SURFACES.every((surface) => typeof o[surface] === 'boolean')
}

const SC: readonly DeveloperSurface[] = ['sourceControl']
const CG: readonly DeveloperSurface[] = ['commitGraph']
const WT: readonly DeveloperSurface[] = ['worktrees']
const SC_CG: readonly DeveloperSurface[] = ['sourceControl', 'commitGraph']
const SC_WT: readonly DeveloperSurface[] = ['sourceControl', 'worktrees']
const SC_RS_WT: readonly DeveloperSurface[] = ['sourceControl', 'repositoryStatus', 'worktrees']
const REPO_FEED: readonly DeveloperSurface[] = ['sourceControl', 'commitGraph', 'repositoryStatus']
const ANY: readonly DeveloperSurface[] = DEVELOPER_SURFACES

/**
 * The surfaces each `studio_action` serves. An action that feeds several
 * surfaces is refused only when every one of them is disabled. An action
 * absent from this table is not a developer-surface action: `git.isRepo` and
 * `git.ignoredFiles` are here by omission, because the directory picker and
 * the file explorer need them with every surface off.
 */
const ACTION_SURFACES: Record<string, readonly DeveloperSurface[]> = {
  // ── Repository feed shared by the changes panel, the graph, and status ──
  'git.subscribe': REPO_FEED,
  'git.unsubscribe': REPO_FEED,
  'git.refresh': REPO_FEED,
  'git.branches': ANY,
  'git.changes': SC_RS_WT,
  'git.opState': SC_WT,
  'git.stashList': SC_CG,
  'git.showFile': SC_CG,
  'git.recentRefs': SC_CG,

  // ── Source control: the changes panel and every repository write ──
  'git.diff': SC,
  'git.blame': SC,
  'git.conflictStages': SC,
  'git.rebaseTodo': SC,
  'git.commit': SC,
  'git.fetch': SC,
  'git.pull': SC,
  'git.push': SC,
  'git.checkout': SC,
  'git.createBranch': SC,
  'git.deleteBranch': SC,
  'git.stage': SC,
  'git.unstage': SC,
  'git.discard': SC,
  'git.stashSave': SC,
  'git.stashPop': SC,
  'git.stashDrop': SC,
  'git.cherryPick': SC,
  'git.revert': SC,
  'git.reset': SC,
  'git.resolveConflict': SC,
  'git.applyPatch': SC,
  'git.tagCreate': SC,
  'git.conflictAccept': SC,
  'git.rebaseExec': SC,
  'git.rebaseAbort': SC,
  'git.rebaseContinue': SC,

  // ── Commit graph ──
  'git.graph': CG,
  'git.commitDetail': CG,
  'git.commitFiles': CG,
  'git.commitFileDiff': CG,
  'git.commitSignature': CG,

  // ── Worktrees and benches ──
  'git.worktreeAppraise': WT,
  'git.worktreeRetirePreview': WT,
  'git.worktreeRebase': WT,
  'git.worktreeSetTitle': WT,
  'worktree.state': WT,
  'worktree.syncAll': WT,
  'worktree.overlap.analyze': WT,
  'worktree.overlap.preview': WT,
  'worktree.overlap.solve': WT,
  'worktree.overlap.autoOrder': WT,
  'worktree.overlap.applyPreview': WT,
  'worktree.overlap.apply': WT,
  finishWorktreeTab: WT,
  landAndRetireWorktree: WT,
  convertToWorktree: WT,
  setupWorktree: WT,
  createWorktree: WT,
  cancelWorktreeSetup: WT,
  renameWorktree: WT,
  refreshWorktreeInventory: WT,
  refreshBench: WT,
  benchRerereCount: WT,
  openWorktreeConversation: WT,
  newWorktreeConversation: WT,
  syncWorktree: WT,
  startWorktreePipeline: WT,
  confirmWorktreePipelineAi: WT,
  cancelWorktreePipeline: WT,
  dismissWorktreePipeline: WT,
  retireWorktree: WT,
  reprovisionWorktree: WT,
  openBenchConversation: WT,
  cycleBenchConversation: WT,
  openBenchTerminal: WT,
  benchAssemble: WT,
  benchResolveConflict: WT,
  benchRerereForget: WT,
  benchRerereDiscardAll: WT,
  benchUpdateMember: WT,
  benchUpdateAll: WT,
  benchAddMember: WT,
  benchRemoveMember: WT,
  setWorktreeStage: WT,
  benchSetReview: WT,
  benchSetOrder: WT,
  openBenchVerificationAnalysis: WT,
  benchDiscardMemberRecordings: WT,
  benchApplyOverlapFastLane: WT,
  retireLandedWorktrees: WT,
  sealLandedWorktree: WT,
}

/** The surfaces `action` serves, or undefined when it is not a developer-surface action. */
export function developerSurfacesOfAction(action: string): readonly DeveloperSurface[] | undefined {
  return ACTION_SURFACES[action]
}

/** Every action the table classifies, for the tests that pin its coverage. */
export function classifiedDeveloperSurfaceActions(): string[] {
  return Object.keys(ACTION_SURFACES)
}

/**
 * The disabled surfaces that put `action` out of reach, or null when it may
 * run: it is unclassified, or at least one surface it serves is on.
 */
export function developerSurfaceBlock(action: string, state: DeveloperSurfaceState): readonly DeveloperSurface[] | null {
  const surfaces = ACTION_SURFACES[action]
  if (!surfaces) return null
  return surfaces.some((surface) => state[surface]) ? null : surfaces
}

/** Events that belong to one surface, by Studio wire channel. */
const CHANNEL_SURFACES: Record<string, readonly DeveloperSurface[]> = {
  'ion:git-event': REPO_FEED,
  'ion:worktree-titled': WT,
  'ion:worktree-landed': WT,
}

/** Thin-view event types that belong to one surface, by type prefix. */
const THIN_EVENT_PREFIX_SURFACES: ReadonlyArray<[string, readonly DeveloperSurface[]]> = [
  ['desktop_worktree_', WT],
  ['desktop_bench_', WT],
  ['desktop_git_', REPO_FEED],
]

function surfacesReachable(surfaces: readonly DeveloperSurface[], state: DeveloperSurfaceState): boolean {
  return surfaces.some((surface) => state[surface])
}

/** Whether an event on `channel` may be delivered under `state`. */
export function developerSurfaceChannelAllowed(channel: string, state: DeveloperSurfaceState): boolean {
  const surfaces = CHANNEL_SURFACES[channel]
  return surfaces ? surfacesReachable(surfaces, state) : true
}

/** Whether a thin-view event of `type` may be delivered under `state`. */
export function developerSurfaceThinEventAllowed(type: string, state: DeveloperSurfaceState): boolean {
  for (const [prefix, surfaces] of THIN_EVENT_PREFIX_SURFACES) {
    if (type.startsWith(prefix)) return surfacesReachable(surfaces, state)
  }
  return true
}

/**
 * A worktree snapshot with the parts of a disabled surface emptied. The
 * snapshot carries two surfaces at once: worktree and bench state, and the
 * source-control conflict alerts. Returns `snapshot` itself when both are on.
 */
export function projectWorktreeSnapshotForSurfaces(snapshot: StudioWorktreeSnapshot, state: DeveloperSurfaceState): StudioWorktreeSnapshot {
  if (state.worktrees && state.sourceControl) return snapshot
  const projected = { ...snapshot }
  if (!state.worktrees) {
    projected.inventory = {}
    projected.workspaces = {}
    projected.benchSourceTips = []
    projected.benchRetired = []
    projected.worktreePipeline = null
    projected.workspaceOperationLedger = []
  }
  if (!state.sourceControl) projected.gitConflictAlerts = []
  return projected
}
