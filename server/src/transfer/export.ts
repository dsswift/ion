/**
 * transfer/export — `transfer.export{tabId, targetEnvironmentId}` core logic
 * (spec 10 Phase 2). Pure orchestration function, independent of the Studio
 * wire and the live session store, so it can be exercised directly against
 * temp directories in a test (`__tests__/export.test.ts`) — the wire
 * handler that pulls live tab state and streams the result over the binary
 * channel lives in `actions.ts`.
 *
 * Order matters here and is spec-mandated: refuse, THEN mark `sealPending`
 * and persist it, THEN start reading conversation files. Persisting before
 * reading is what makes the tab's prompt-refusal (`prompt-acceptance.ts`)
 * effective from before the first byte of the archive is built — a prompt
 * that raced in after the archive started would otherwise diverge from
 * what was already streamed.
 */
import type { WorktreeInfo } from '@ion/shared/types-session'
import type { BundleOptions } from './git-worktree-bundle'
import type { PersistedTab, ExternalInstanceContent } from '@ion/shared/types-persistence'
import { collectFamily, conversationsOwnedByOtherTabs } from './collect-family'
import { readTabsState } from './tabs-file'
import { buildTransferArchive } from './archive'
import { planTransferEntries, digestEntries } from './entries'
import { buildTransferManifest, type TransferAttachment, type TransferManifest, type TransferResourceState, type TransferWorktreeManifest } from './manifest'
import { collectReferences } from './references'
import type { ResourceItem } from '@ion/shared/types-resource'
import { resourceIdentity } from '@ion/shared/resource-identity'
import { existsSync, readdirSync } from 'fs'
import { join, sep } from 'path'
import { ensureRepoRemote, projectsIoFor } from './repo-remote'
import type { TransferPaths } from './paths'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.export'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export type ExportRefusalCode = 'running' | 'dirty_worktree' | 'seal_pending' | 'archive_failed' | 'resource_export_failed'

export interface ExportRefusal {
  code: ExportRefusalCode
  message: string
}

/** The subset of live tab state export needs. Matches `TabState` structurally. */
export interface ExportTabSnapshot {
  id: string
  status: string
  worktree: WorktreeInfo | null
}

export interface RunTransferExportArgs {
  tab: ExportTabSnapshot
  /** The persisted record embedded in `transfer.json`, read from `tabsFile`. */
  tabRecord: PersistedTab
  tabContent: ExternalInstanceContent | null
  targetEnvironmentId: string
  sourceEnvironmentId: string
  paths: TransferPaths
  /** Absolute path this export writes its archive to (a temp file the caller cleans up). */
  destinationPath: string
  /** Real implementation runs `git status --porcelain -uall`; injectable for tests. */
  isWorktreeDirty: (worktreePath: string) => Promise<boolean>
  /** Real implementation runs `git bundle create`; injectable for tests. Returns null when the worktree has no commits ahead of `sourceBranch` worth bundling is still a valid bundle — null means bundling itself failed. */
  buildWorktreeBundle: (worktree: WorktreeInfo, options?: BundleOptions) => Promise<{ bundlePath: string } | null>
  /** How the worktree bundle is cut, from the destination's `transfer.preflight` answer. Absent: thin bundle. */
  bundleOptions?: BundleOptions
  /** Writes `sealPending` to `tabsFile` and returns once durable. Called BEFORE any conversation file is read. */
  persistSealPending: (sealPending: { targetEnvironmentId: string; since: number; carriesWorktree: boolean }) => Promise<void> | void
  /**
   * Clears the mark `persistSealPending` set, when the export fails after
   * setting it: no archive exists, so nothing can reach the destination.
   */
  releaseSealPending?: (sealPending: { targetEnvironmentId: string; since: number; carriesWorktree: boolean }) => Promise<void> | void
  /**
   * The read and deleted marks among the given resource identities. The
   * marks live in the server's resource state; injected so this function
   * stays testable against temp directories. Absent: no marks travel.
   */
  resourceStateFor?: (identities: string[]) => TransferResourceState
  /**
   * The extension resources held for the moving conversations, from their
   * producers (`extension-resources.ts`). Absent: none travel. A failure
   * refuses the export: a move never loses a resource.
   */
  exportResources?: (conversationIds: string[]) => Promise<{ ok: true; items: ResourceItem[] } | { ok: false; message: string }>
  /**
   * Whether the conversation's worktree travels with it. False moves the
   * conversation on its own: no bundle, no worktree in the manifest, and the
   * tab lands wherever the destination is told. The worktree stays here with
   * its other conversations, which is also why its uncommitted state does
   * not block this kind of move — nothing in the checkout is being packaged.
   */
  carryWorktree?: boolean
  now?: () => number
}

export type RunTransferExportResult =
  | { ok: true; archivePath: string; totalBytes: number; manifest: TransferManifest; rootConversationId: string; sealedAt: number }
  | { ok: false; refusal: ExportRefusal }

export async function runTransferExport(args: RunTransferExportArgs): Promise<RunTransferExportResult> {
  const { tab, tabRecord } = args
  const logFields = { source_environment_id: args.sourceEnvironmentId, target_environment_id: args.targetEnvironmentId, tab_id: tab.id }

  if (tab.status === 'running' || tab.status === 'starting') {
    log('refused: running', { ...logFields, step: 'refuse', outcome: 'running' })
    return { ok: false, refusal: { code: 'running', message: `tab is ${tab.status}` } }
  }
  if (tabRecord.sealPending && tabRecord.sealPending.targetEnvironmentId !== args.targetEnvironmentId) {
    log('refused: seal_pending', { ...logFields, step: 'refuse', outcome: 'seal_pending' })
    return { ok: false, refusal: { code: 'seal_pending', message: `already sealed for transfer to ${tabRecord.sealPending.targetEnvironmentId}` } }
  }
  // The worktree travels only when asked. Everything below reads this, not
  // `tab.worktree`, so a conversation leaving its worktree is exported
  // exactly like a plain one.
  const carried = args.carryWorktree ? tab.worktree : null
  if (tab.worktree && !carried) {
    log('exporting the conversation without its worktree', { ...logFields, worktree_path: tab.worktree.worktreePath, step: 'refuse', outcome: 'conversation_only' })
  }
  if (carried) {
    let dirty: boolean
    try {
      dirty = await args.isWorktreeDirty(carried.worktreePath)
    } catch (err) {
      warn('dirty check failed; refusing', { ...logFields, error: String(err) })
      return { ok: false, refusal: { code: 'dirty_worktree', message: `could not determine worktree cleanliness: ${String(err)}` } }
    }
    if (dirty) {
      log('refused: dirty_worktree', { ...logFields, step: 'refuse', outcome: 'dirty_worktree' })
      return { ok: false, refusal: { code: 'dirty_worktree', message: 'worktree has uncommitted changes' } }
    }
  }

  const now = args.now?.() ?? Date.now()
  // The mark records whether the worktree is in the archive: the removal
  // that ends this move retires the checkout only when it was shipped.
  const sealPending = { targetEnvironmentId: args.targetEnvironmentId, since: now, carriesWorktree: !!carried }
  await args.persistSealPending(sealPending)
  log('sealPending persisted', { ...logFields, step: 'seal_pending', outcome: 'ok', carries_worktree: sealPending.carriesWorktree })

  let built = false
  try {
    const result = await exportSealed(args, sealPending, now, logFields)
    built = result.ok
    return result
  } finally {
    if (!built) {
      log('export failed after marking the tab; releasing the mark', { ...logFields, step: 'release', outcome: 'released' })
      await args.releaseSealPending?.(sealPending)
    }
  }
}

/** Everything after the mark is set; any failure here releases it. */
async function exportSealed(
  args: RunTransferExportArgs,
  sealPending: { targetEnvironmentId: string; since: number; carriesWorktree: boolean },
  now: number,
  logFields: Record<string, string>,
): Promise<RunTransferExportResult> {
  const { tab, tabRecord } = args
  const carried = args.carryWorktree ? tab.worktree : null

  const rootConversationId = tabRecord.conversationId ?? tab.id
  // The tab's own conversations and their dispatch children; never a fork or
  // a conversation another tab owns (collect-family.ts).
  const family = await collectFamily(rootConversationId, args.paths.conversationsDir, {
    tab: tabRecord,
    ownedElsewhere: conversationsOwnedByOtherTabs(readTabsState(args.paths.tabsFile), tab.id),
  })
  log('family collected', { ...logFields, root_conversation_id: rootConversationId, step: 'collect', outcome: 'ok', conversation_count: family.ids.length })

  const worktree = carried ? await buildWorktreeManifest(carried, args.paths, args.buildWorktreeBundle, args.bundleOptions) : { manifest: null, bundlePath: null }

  // Files outside the family's own folders that its history names ride as
  // attachments, and land in the conversation's own folder on arrival.
  const { references, missing } = collectReferences({
    conversationsDir: args.paths.conversationsDir,
    members: family.members,
    rootConversationId,
    tabData: [tabRecord, args.tabContent],
  })
  const attachments: TransferAttachment[] = references.map((ref, index) => ({ entry: `attachments/${index}`, sourcePath: ref.path, kind: ref.kind, ownerId: ref.ownerId }))
  const chartsRoot = join(args.paths.dataDir, 'resources')

  // Plan and digest before the manifest is built: the manifest carries the
  // digests, and it is itself an entry in the archive.
  const entries = planTransferEntries(args.paths.conversationsDir, family.members, worktree.bundlePath, {
    chartsRoot,
    attachments: attachments.map((a) => ({ name: a.entry, path: a.sourcePath })),
  })
  const files = await digestEntries(entries)

  let extensionResources: ResourceItem[] = []
  if (args.exportResources) {
    const exported = await args.exportResources(family.ids)
    if (!exported.ok) {
      warn('refused: extension resources could not be exported', { ...logFields, root_conversation_id: rootConversationId, step: 'resources', outcome: 'resource_export_failed', error: exported.message })
      return { ok: false, refusal: { code: 'resource_export_failed', message: exported.message } }
    }
    extensionResources = exported.items
  }
  const identities = [...chartIdentities(chartsRoot, family.ids), ...extensionResources.map((item) => resourceIdentity(item))]
  const resourceState = args.resourceStateFor?.(identities) ?? { read: [], deleted: [] }
  log('files planned', {
    ...logFields,
    root_conversation_id: rootConversationId,
    step: 'plan',
    entry_count: entries.length,
    attachment_count: attachments.length,
    missing_count: missing.length,
    extension_resources: extensionResources.length,
    read_marks: resourceState.read.length,
    deleted_marks: resourceState.deleted.length,
  })

  const manifest = buildTransferManifest({
    rootConversationId,
    conversationIds: family.ids,
    sourceEnvironmentId: args.sourceEnvironmentId,
    exportedAt: now,
    // A conversation leaving its worktree carries no worktree identity: on
    // the destination it is a plain conversation until it is landed.
    tabRecord: carried ? { ...tabRecord, sealPending } : { ...tabRecord, sealPending, worktree: undefined },
    tabContent: args.tabContent,
    worktree: worktree.manifest,
    files,
    attachments,
    missingAttachments: missing,
    sourceRoots: {
      conversationsDir: args.paths.conversationsDir,
      dataDir: args.paths.dataDir,
      workingDirectory: tabRecord.workingDirectory ?? '',
      separator: sep,
    },
    resourceState,
    extensionResources,
  })

  const built = await buildTransferArchive({ destinationPath: args.destinationPath, manifest, entries })
  if (!built.ok) {
    warn('archive build failed', { ...logFields, root_conversation_id: rootConversationId, step: 'archive', outcome: 'failed', error: built.error })
    return { ok: false, refusal: { code: 'archive_failed', message: built.error ?? 'archive build failed' } }
  }

  log('export complete', { ...logFields, root_conversation_id: rootConversationId, step: 'archive', outcome: 'ok', bytes_written: built.bytesWritten })
  return { ok: true, archivePath: args.destinationPath, totalBytes: built.bytesWritten ?? 0, manifest, rootConversationId, sealedAt: sealPending.since }
}

async function buildWorktreeManifest(
  worktree: WorktreeInfo,
  paths: TransferPaths,
  buildBundle: RunTransferExportArgs['buildWorktreeBundle'],
  options: BundleOptions | undefined,
): Promise<{ manifest: TransferWorktreeManifest | null; bundlePath: string | null }> {
  const repoRemote = await ensureRepoRemote(worktree.repoPath, projectsIoFor(paths.settingsFile))
  if (!repoRemote) {
    warn('worktree has no resolvable repoRemote; exporting without worktree', { repo_path: worktree.repoPath })
    return { manifest: null, bundlePath: null }
  }
  const built = await buildBundle(worktree, options)
  if (!built) {
    warn('worktree bundle build failed; exporting without worktree', { repo_path: worktree.repoPath })
    return { manifest: null, bundlePath: null }
  }
  return {
    manifest: { repoRemote, branch: worktree.branchName, sourceBranch: worktree.sourceBranch, bundlePath: 'worktree.bundle', ...(options?.includeSourceBranch ? { bundleIncludesSourceBranch: true } : {}) },
    bundlePath: built.bundlePath,
  }
}

/**
 * The resource identities of the family's charts: a chart's identity is its
 * id (charts carry no producer), and its file is
 * `<dataDir>/resources/<conversationId>/chart-<id>.json`.
 */
function chartIdentities(chartsRoot: string, conversationIds: readonly string[]): string[] {
  const ids: string[] = []
  for (const conversationId of conversationIds) {
    const dir = join(chartsRoot, conversationId)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const m = /^chart-(.+)\.json$/.exec(name)
      if (m) ids.push(m[1])
    }
  }
  return ids
}
