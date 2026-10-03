/**
 * transfer/import — `transfer.import{archive}` core logic (spec 10 Phase 3).
 *
 * Everything up through manifest + collision + repo validation happens
 * against the STAGING directory only — nothing under `paths.conversationsDir`,
 * `paths.tabsFile`, or `paths.tabContentDir` is touched until every refusal
 * check has passed. `commit()` only runs after that point, and the staging
 * directory is always removed afterward (success or failure) so a transfer
 * never leaves `transfer-inbox/` accreting scratch directories.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { PersistedTab, PersistedTabState, ExternalInstanceContent } from '@ion/shared/types-persistence'
import type { WorktreeInfo } from '@ion/shared/types-session'
import { extractTransferArchive } from './archive'
import { verifyAgainstDigests } from './entries'
import { resolveLanding, defaultLandingDeps, type Landing, type LandingDeps } from './landing'
import type { TransferManifest, TransferResourceState } from './manifest'
import { commitStagedFiles, committedPathFor, destinationPathMap, placeAttachments, rewriteStagedConversations, rollBack } from './import-files'
import { rewriteJsonValue } from './path-rewrite'
import { findTab, readTabsState, writeTabsState } from './tabs-file'
import type { ResourceItem } from '@ion/shared/types-resource'
import { projectPathByRepoRemote, projectsIoFor } from './repo-remote'
import { transferInboxDir, type TransferPaths } from './paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.import'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export type ImportRefusalCode =
  | 'extract_failed'
  | 'invalid_manifest'
  | 'version_mismatch'
  | 'conversation_exists'
  | 'unknown_repo'
  | 'source_branch_missing'
  /** The conversation would arrive in a worktree, and this server's policy does not offer worktrees. */
  | 'worktrees_not_offered'
  /** This machine already holds a copy of the worktree and it has uncommitted changes, so it cannot be set to the incoming tip. */
  | 'worktree_dirty'
  /** What arrived, or what was written, does not match the digests the source recorded. The source is never deleted after this. */
  | 'verification_failed'
  /** A plain conversation with no directory on this machine to land in. It is never imported pointing at the source's path. */
  | 'no_destination_directory'
  /** An extension whose resources the conversation carries is not installed here, or cannot take them. Nothing is imported. */
  | 'resource_producer_missing'
  /** An extension here refused the conversation's resources. Nothing is imported. */
  | 'resource_import_failed'

export interface ImportRefusal {
  code: ImportRefusalCode
  message: string
}

export interface CheckoutWorktreeResult {
  worktreePath: string
  /** True when an existing checkout of the branch (a sealed copy coming home, or a sibling's) was updated in place rather than created. */
  reused?: boolean
}

/** A checkout that could not proceed for a reason the operator can act on (as opposed to `null`, the source-branch-missing case). */
export interface CheckoutWorktreeRefusal {
  refusal: { code: 'worktree_dirty'; message: string }
}

function isCheckoutRefusal(value: CheckoutWorktreeResult | CheckoutWorktreeRefusal | null): value is CheckoutWorktreeRefusal {
  return value !== null && 'refusal' in value
}

export interface RunTransferImportArgs {
  archivePath: string
  paths: TransferPaths
  /**
   * Whether this server's policy offers the worktrees developer surface.
   * False refuses an import that brings a worktree or asks for a new one.
   * Absent means offered.
   */
  worktreesOffered?: boolean
  /** The importing caller's subject — stamped onto the new tab's `principalSubject`, never the exporter's. */
  callerSubject: string
  /**
   * Where a conversation arriving WITHOUT a worktree lands on this machine:
   * a project checkout, an existing worktree, or a new one — chosen in the
   * source dialog from what this machine offers (`landing.ts`). A
   * conversation's working directory is a path on the machine it left, so
   * it is never carried across. Ignored when the conversation brings its
   * worktree, whose directory is the checkout this import creates.
   */
  landing?: Landing
  /** Injectable for tests; defaults to this machine's registry, projects, and git. */
  landingDeps?: LandingDeps
  /**
   * Hands the conversation's extension resources to this machine's
   * producers (`extension-resources.ts`). Called once the tab record is
   * written, because the producers load in the tab's own session. Anything
   * but ok undoes the whole import and refuses. Absent: an archive that
   * carries extension resources is refused, since nothing here could take them.
   */
  importResources?: (args: { tabId: string; conversationIds: string[]; items: ResourceItem[] }) => Promise<
    { ok: true } | { ok: false; code: 'resource_producer_missing' | 'resource_import_failed'; message: string }
  >
  /**
   * Real implementation fetches `bundlePath`'s branch into the matched
   * project and runs `git worktree add`. Returns null when the source
   * branch (or the bundle itself) cannot be resolved locally — the C8
   * `source_branch_missing` refusal.
   */
  checkoutWorktreeFromBundle: (args: {
    bundlePath: string
    branch: string
    sourceBranch: string
    repoPath: string
    /** From the manifest: the bundle carries `sourceBranch` too, so a missing one is created from it. */
    bundleIncludesSourceBranch?: boolean
  }) => Promise<CheckoutWorktreeResult | CheckoutWorktreeRefusal | null>
}

export type RunTransferImportResult =
  | {
      ok: true
      rootConversationId: string
      /** Every conversation the import wrote. */
      conversationIds: string[]
      tabId: string
      /** The moved resources' read and deleted marks, for the caller to merge into this machine's state. */
      resourceState: TransferResourceState
      worktreePath: string | null
      verifiedFiles: number
      /**
       * Set when this import made a new checkout from the bundle, which then
       * has none of its gitignored build state. The caller provisions it once
       * the import has fully succeeded, so a rolled-back import never has a
       * build running into a checkout that is being removed.
       */
      restoredWorktree?: { repoPath: string; worktreePath: string }
    }
  | { ok: false; refusal: ImportRefusal }

function conversationExistsAt(conversationsDir: string, id: string): boolean {
  const llm = join(conversationsDir, `${id}.llm.jsonl`)
  const tree = join(conversationsDir, `${id}.tree.jsonl`)
  if (existsSync(llm) && existsSync(tree)) return true
  if (existsSync(join(conversationsDir, `${id}.jsonl`))) return true
  if (existsSync(join(conversationsDir, `${id}.json`))) return true
  return false
}

function appendTabRecord(tabsFile: string, tab: PersistedTab): void {
  let state: PersistedTabState = { activeSessionId: null, tabs: [] }
  if (existsSync(tabsFile)) {
    try {
      state = JSON.parse(readFileSync(tabsFile, 'utf-8')) as PersistedTabState
    } catch (err) {
      warn('appendTabRecord: tabs file unreadable, starting fresh', { tabs_file: tabsFile, error: String(err) })
    }
  }
  const tabs = Array.isArray(state.tabs) ? state.tabs : []
  mkdirSync(dirname(tabsFile), { recursive: true })
  atomicWriteFileSync(tabsFile, JSON.stringify({ ...state, tabs: [...tabs, tab] }, null, 2), 0o644)
}

/** Removes a tab record `appendTabRecord` wrote, when the import is undone. */
function removeTabRecord(tabsFile: string, tabId: string): void {
  const state = readTabsState(tabsFile)
  const found = findTab(state, tabId)
  if (!found) return
  state.tabs.splice(found.index, 1)
  writeTabsState(tabsFile, state)
}

function writeTabContentFile(tabContentDir: string, tabId: string, content: ExternalInstanceContent): void {
  mkdirSync(tabContentDir, { recursive: true })
  atomicWriteFileSync(join(tabContentDir, `${tabId}.json`), JSON.stringify(content), 0o644)
}

async function resolveWorktree(
  manifest: TransferManifest,
  bundlePath: string | undefined,
  paths: TransferPaths,
  checkout: RunTransferImportArgs['checkoutWorktreeFromBundle'],
): Promise<{ ok: true; result: CheckoutWorktreeResult | null } | { ok: false; refusal: ImportRefusal }> {
  if (!manifest.worktree) return { ok: true, result: null }

  const projectPath = projectPathByRepoRemote(manifest.worktree.repoRemote, projectsIoFor(paths.settingsFile).readProjects)
  if (!projectPath) {
    return { ok: false, refusal: { code: 'unknown_repo', message: `no local project matches repoRemote ${manifest.worktree.repoRemote}` } }
  }
  if (!bundlePath) {
    return { ok: false, refusal: { code: 'source_branch_missing', message: 'transfer.json declares a worktree but the archive carries no worktree.bundle' } }
  }

  const checkedOut = await checkout({
    bundlePath,
    branch: manifest.worktree.branch,
    sourceBranch: manifest.worktree.sourceBranch,
    repoPath: projectPath,
    bundleIncludesSourceBranch: manifest.worktree.bundleIncludesSourceBranch === true,
  })
  if (isCheckoutRefusal(checkedOut)) {
    return { ok: false, refusal: checkedOut.refusal }
  }
  if (!checkedOut) {
    return { ok: false, refusal: { code: 'source_branch_missing', message: `could not restore worktree: source branch ${manifest.worktree.sourceBranch} is not available in ${projectPath}` } }
  }
  return { ok: true, result: checkedOut }
}

export async function runTransferImport(args: RunTransferImportArgs): Promise<RunTransferImportResult> {
  const stagingDir = join(transferInboxDir(args.paths), `stage-${randomUUID()}`)
  const logFields = { staging_dir: stagingDir }

  try {
    const extracted = await extractTransferArchive(args.archivePath, stagingDir)
    if (!extracted.ok || !extracted.manifest) {
      log('refused: extract failed', { ...logFields, step: 'extract', outcome: 'extract_failed', error: extracted.error })
      return { ok: false, refusal: { code: 'extract_failed', message: extracted.error ?? 'archive did not extract' } }
    }
    const manifest = extracted.manifest

    // Verify what arrived before anything is written into the conversation
    // store. The source is deleted once this import reports ok, so "ok" has
    // to mean the bytes here are the bytes that left.
    const staged = await verifyAgainstDigests(stagingDir, manifest.files)
    if (!staged.ok) {
      log('refused: the archive does not match the digests the source recorded', {
        ...logFields,
        root_conversation_id: manifest.rootConversationId,
        step: 'verify',
        outcome: 'verification_failed',
        mismatched: staged.mismatched.join(','),
        missing: staged.missing.join(','),
      })
      return { ok: false, refusal: { code: 'verification_failed', message: `archive did not verify: ${[...staged.mismatched, ...staged.missing].join(', ')}` } }
    }

    // A conversation this machine already has is a duplicate, always. A
    // transfer deletes the copy it came from, so a conversation that once
    // lived here and moved away left nothing behind to come home to.
    for (const id of manifest.conversationIds) {
      if (conversationExistsAt(args.paths.conversationsDir, id)) {
        log('refused: conversation_exists', { ...logFields, root_conversation_id: manifest.rootConversationId, step: 'validate', outcome: 'conversation_exists', conversation_id: id })
        return { ok: false, refusal: { code: 'conversation_exists', message: `conversation ${id} already exists locally` } }
      }
    }

    if (args.worktreesOffered === false && (manifest.worktree || args.landing?.kind === 'new-worktree')) {
      log('refused: worktrees are not offered on this server', { ...logFields, root_conversation_id: manifest.rootConversationId, step: 'validate', outcome: 'worktrees_not_offered', brings_worktree: !!manifest.worktree })
      return { ok: false, refusal: { code: 'worktrees_not_offered', message: 'this server does not offer worktrees, so a conversation cannot arrive in one' } }
    }

    const worktreeResolution = await resolveWorktree(manifest, extracted.bundlePath, args.paths, args.checkoutWorktreeFromBundle)
    if (!worktreeResolution.ok) {
      log('refused', { ...logFields, root_conversation_id: manifest.rootConversationId, step: 'validate', outcome: worktreeResolution.refusal.code })
      return { ok: false, refusal: worktreeResolution.refusal }
    }

    // A conversation arriving without its worktree must say where it lands.
    const refuseLanding = (message: string): RunTransferImportResult => {
      log('refused: nowhere on this machine to land the conversation', {
        ...logFields,
        root_conversation_id: manifest.rootConversationId,
        step: 'validate',
        outcome: 'no_destination_directory',
        landing_kind: args.landing?.kind ?? '',
        source_directory: manifest.tabRecord.workingDirectory ?? '',
      })
      return { ok: false, refusal: { code: 'no_destination_directory', message } }
    }
    if (!manifest.worktree && !args.landing) return refuseLanding('no place on this machine was chosen for the conversation')
    const landingDeps = args.landingDeps ?? defaultLandingDeps(args.paths)

    // Where the conversation lives here. A conversation that brought its
    // worktree lives in the checkout made above; any other is resolved from
    // the chosen landing now, before anything is written, because every
    // path it stores is rewritten against this directory. A new worktree is
    // a real checkout, so it is cut only after every refusal check above has
    // passed, and it is removed again if the import fails after this point.
    let landed: { workingDirectory: string; worktree: WorktreeInfo | null; created: boolean } | null = null
    if (!manifest.worktree && args.landing) {
      const resolved = await resolveLanding(args.landing, landingDeps)
      if (!resolved.ok) return refuseLanding(resolved.message)
      landed = { workingDirectory: resolved.workingDirectory, worktree: resolved.worktree, created: args.landing.kind === 'new-worktree' }
    }
    const workingDirectory = worktreeResolution.result ? worktreeResolution.result.worktreePath : landed?.workingDirectory ?? ''
    const discardLanding = async (): Promise<void> => {
      if (!landed?.created || !landed.worktree || !landingDeps.discardWorktree) return
      await landingDeps.discardWorktree(landed.worktree)
    }

    // Every file the conversation brings lands in its own space here, and
    // every path it stores is rewritten to match — in staging, so a refusal
    // from here on leaves this machine as it was.
    const dest = { conversationsDir: args.paths.conversationsDir, dataDir: args.paths.dataDir }
    const placements = placeAttachments(stagingDir, manifest, dest, workingDirectory)
    const pathMap = destinationPathMap(manifest, dest, workingDirectory, placements)
    const rewritten = rewriteStagedConversations(stagingDir, pathMap)

    // Every refusal check has passed — commit.
    const written = commitStagedFiles(stagingDir, dest, placements)
    const rollbackFields = { ...logFields, root_conversation_id: manifest.rootConversationId }

    // And verify the committed copy, which is what the source is about to be
    // deleted in favour of: each file against the bytes it should have — the
    // rewritten ones against what was written, the rest against the source's
    // digests. A failure here rolls everything back and refuses: the source
    // stays, and a retry starts clean.
    const expected = { ...manifest.files, ...rewritten.digests }
    const committed = await verifyAgainstDigests(args.paths.conversationsDir, expected, {
      // The bundle is consumed by git during checkout, never committed, and
      // was already verified in staging above.
      skip: (name) => committedPathFor(name, dest, placements) === null,
      nameToPath: (name) => committedPathFor(name, dest, placements)!,
    })
    if (!committed.ok) {
      warn('committed files do not match the source', {
        ...logFields,
        root_conversation_id: manifest.rootConversationId,
        step: 'verify_committed',
        outcome: 'verification_failed',
        mismatched: committed.mismatched.join(','),
        missing: committed.missing.join(','),
      })
      rollBack(written, rollbackFields)
      await discardLanding()
      return { ok: false, refusal: { code: 'verification_failed', message: `the imported copy did not verify: ${[...committed.mismatched, ...committed.missing].join(', ')}` } }
    }

    const tabId = manifest.tabRecord.id ?? manifest.rootConversationId
    const worktree: WorktreeInfo | null = worktreeResolution.result
      ? {
          worktreePath: worktreeResolution.result.worktreePath,
          branchName: manifest.worktree!.branch,
          sourceBranch: manifest.worktree!.sourceBranch,
          repoPath: projectPathByRepoRemote(manifest.worktree!.repoRemote, projectsIoFor(args.paths.settingsFile).readProjects)!,
        }
      : landed?.worktree ?? null
    const importedTabId = tabId
    // The tab record and content carry their own copies of stored paths (a
    // plan's path, an attachment's), rewritten with the same map.
    const tabRecord = rewriteJsonValue(manifest.tabRecord, pathMap).value
    const tabContent = manifest.tabContent ? rewriteJsonValue(manifest.tabContent, pathMap).value : null
    const importedTab: PersistedTab = {
      ...tabRecord,
      id: importedTabId,
      principalSubject: args.callerSubject,
      worktree,
      workingDirectory,
      sealPending: undefined,
    }
    appendTabRecord(args.paths.tabsFile, importedTab)
    if (tabContent) writeTabContentFile(args.paths.tabContentDir, importedTabId, tabContent)

    // The conversation's extension resources, handed to this machine's
    // producers. A move never loses one: anything short of all of them
    // undoes the import, and the source keeps everything.
    if (manifest.extensionResources.length > 0) {
      const outcome = args.importResources
        ? await args.importResources({ tabId: importedTabId, conversationIds: manifest.conversationIds, items: manifest.extensionResources })
        : { ok: false as const, code: 'resource_producer_missing' as const, message: 'this machine cannot take extension resources' }
      if (!outcome.ok) {
        warn('refused: the conversation\'s extension resources were not taken; undoing the import', { ...rollbackFields, step: 'resources', outcome: outcome.code, error: outcome.message })
        removeTabRecord(args.paths.tabsFile, importedTabId)
        rmSync(join(args.paths.tabContentDir, `${importedTabId}.json`), { force: true })
        rollBack(written, rollbackFields)
        await discardLanding()
        return { ok: false, refusal: { code: outcome.code, message: outcome.message } }
      }
      log('extension resources imported', { ...rollbackFields, step: 'resources', outcome: 'ok', items: manifest.extensionResources.length })
    }

    log('import complete', {
      ...logFields,
      root_conversation_id: manifest.rootConversationId,
      tab_id: importedTabId,
      step: 'commit',
      outcome: 'ok',
      conversation_count: manifest.conversationIds.length,
      has_worktree: !!worktree,
      working_directory: workingDirectory,
      landing_kind: manifest.worktree ? 'carried-worktree' : args.landing?.kind ?? '',
      worktree_reused: worktreeResolution.result?.reused === true,
      verified_files: committed.checked,
      attachments: placements.length,
      rewritten_files: rewritten.files,
      rewritten_paths: rewritten.replaced,
    })
    const restoredWorktree = worktree && worktreeResolution.result && worktreeResolution.result.reused !== true
      ? { repoPath: worktree.repoPath, worktreePath: worktree.worktreePath }
      : undefined
    return {
      ok: true,
      rootConversationId: manifest.rootConversationId,
      conversationIds: manifest.conversationIds,
      tabId: importedTabId,
      worktreePath: worktree?.worktreePath ?? null,
      verifiedFiles: committed.checked,
      resourceState: manifest.resourceState,
      ...(restoredWorktree ? { restoredWorktree } : {}),
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}
