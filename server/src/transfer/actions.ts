/**
 * transfer/actions — the `transfer.*` `studio_action` registry (spec 10).
 *
 * A separate registry from `protocol/actions.ts`'s `ACTIONS`
 * (`FORWARDED_ACTIONS`, mirror-store actions) and structurally identical to
 * `auth/actions.ts`'s `AUTH_ACTIONS`: every `transfer.*` action here is
 * server-only orchestration with no session-store equivalent — but unlike
 * `AUTH_ACTIONS`'s synchronous handlers, these are genuinely async (archive
 * I/O, git plumbing), so `TransferActionSpec.handler` returns a Promise and
 * `protocol/actions.ts#handleAction` awaits it.
 *
 * `transfer.export` replies with `{transferId, totalBytes, rootConversationId}`
 * and then streams the archive as binary `FILE_CHUNK` frames keyed by
 * `transferId`. The client names the `transferId` in its request and is
 * listening for it before it sends, because a small archive reaches it in
 * the same read as the reply and a WebSocket client hands those frames out
 * back to back. `setImmediate` still puts the frames on the socket after
 * the reply, which a client that listens early does not depend on. `transfer.remove` is the last step of a move: the source deletes what it
 * held once the destination has verified its copy.
 *
 * `transfer.import` is the mirror image: the CLIENT picks
 * `transferId` and sends `{transferId, totalBytes}`, then streams chunks
 * immediately; this handler registers the inbound transfer SYNCHRONOUSLY
 * (before its first `await`) so a chunk arriving on the very next frame
 * cannot race the registration (see `inbound-transfer.ts`'s doc comment).
 */
import { deriveEnvironmentDeveloperSurfaces } from '@ion/shared/developer-surfaces'
import { enterprisePolicyCache } from '../enterprise-policy-state'
import { mergeResourceState, resourceStateFor } from '../engine/event-wiring-resource-state'
import { forgetMovedCharts, seedImportedCharts } from './charts'
import { defaultResourceWire, exportExtensionResources, forgetExtensionResources, importExtensionResources } from './extension-resources'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Scope } from '@ion/shared/studio-wire/types'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import type { Connection } from '../protocol/connection'
import { useSessionStore } from '../store/sessionStore'
import { engineBridge } from '../state'
import { loadInstanceContent } from '../persistence/tab-content-store'
import { currentEnvironmentId } from '../identity/environment-id'
import { defaultTransferPaths, transferOutboxDir } from './paths'
import { principalSubjectForTab } from '../protocol/tabs-index'
import { currentPrincipal } from '../identity/request-principal'
import { readTab, persistSealPendingOnTabsFile } from './tabs-file'
import { runTransferExport, type ExportRefusalCode } from './export'
import { runTransferImport, type ImportRefusalCode } from './import'
import { abandonPendingTransfer, releaseExportSeal } from './pending'
import { removeTransferredSource } from './remove-source'
import { parseLanding, landingOptionsFor, defaultLandingDeps } from './landing'
import { runRelocate } from './relocate'
import { evaluateSessionBusyGuard } from '../store/slices/session-busy-guard'
import { setTabWorkingDirectory } from '../store/slices/tab-working-directory'
import { startWorktreeProvisioning } from '../worktree/provision-start'
import { adoptImportedTab } from './adopt-imported-tab'
import { warmParentIndex } from './parent-index'
import { isWorktreeDirty, buildWorktreeBundle, checkoutWorktreeFromBundle, branchTips, hasBranch, worktreePathForBranch } from './git-worktree-bundle'
import { projectPathsByRepoRemote, ensureRepoRemote, projectsIoFor } from './repo-remote'
import { runGit } from '../git/git-runner'
import type { TransferPreflight, TransferDescription } from '@ion/shared/types-environment-admin'
import { declaredProvisioning } from '../worktree/provision-manifest'
import { TRANSFER_MANIFEST_VERSION } from './manifest'
import { registerInboundTransfer } from './inbound-transfer'
import { rmSync, createReadStream, existsSync } from 'fs'
import { homedir } from 'os'
import { dirname } from 'path'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer-actions'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export type TransferActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; refusal?: { code: string; message: string } }
  | { ok: false; error: { code: string; message: string } }

export interface TransferActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<TransferActionOutcome>
}

function firstArgObject(args: unknown[]): Record<string, unknown> {
  const a = args[0]
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}
function str(a: Record<string, unknown>, key: string): string {
  const v = a[key]
  return typeof v === 'string' ? v : ''
}
function num(a: Record<string, unknown>, key: string): number {
  const v = a[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const EXPORT_CHUNK_BYTES = 256 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Streams `archivePath` to `conn` as FILE_CHUNK frames keyed by `transferId`, then deletes the temp archive. */
async function streamArchiveToConnection(conn: Connection, transferId: string, archivePath: string): Promise<void> {
  let sentBytes = 0
  try {
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(archivePath, { highWaterMark: EXPORT_CHUNK_BYTES })
      readStream.on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        if (!conn.sendBinary(BinaryChannel.FILE_CHUNK, transferId, buf)) {
          readStream.destroy()
          reject(new Error('connection closed mid-stream'))
          return
        }
        sentBytes += buf.length
      })
      readStream.on('end', resolve)
      readStream.on('error', reject)
    })
    log('export stream complete', { transfer_id: transferId, sent_bytes: sentBytes })
  } catch (err) {
    warn('export stream failed', { transfer_id: transferId, sent_bytes: sentBytes, error: String(err) })
  } finally {
    // Always, on both paths: the receiver needs to know no more bytes are
    // coming. On the success path it confirms the count; on the failure path
    // it turns what would be an indefinite wait into a short-stream error.
    conn.sendBinary(BinaryChannel.FILE_END, transferId, new Uint8Array(0))
    try {
      rmSync(archivePath, { force: true })
    } catch (err) {
      warn('export temp archive cleanup failed', { archive_path: archivePath, error: String(err) })
    }
  }
}

function refusalOutcome(code: string, message: string): TransferActionOutcome {
  return { ok: false, refusal: { code, message } }
}

async function handleTransferExport(conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const tabId = str(a, 'tabId')
  const targetEnvironmentId = str(a, 'targetEnvironmentId')
  if (!tabId || !targetEnvironmentId) {
    return { ok: false, error: { code: 'invalid_args', message: 'tabId and targetEnvironmentId are required' } }
  }

  const liveTab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
  if (!liveTab) return refusalOutcome('not_found', `no open tab ${tabId}`)

  const paths = defaultTransferPaths(principalSubjectForTab(tabId))
  const tabRecord = readTab(paths.tabsFile, tabId)
  if (!tabRecord) return refusalOutcome('not_found', `no persisted record for tab ${tabId}`)

  const destinationPath = join(transferOutboxDir(paths), `${tabId}-${Date.now()}.zip`)
  const result = await runTransferExport({
    tab: { id: liveTab.id, status: liveTab.status, worktree: liveTab.worktree },
    tabRecord,
    tabContent: loadInstanceContent(tabId),
    targetEnvironmentId,
    sourceEnvironmentId: currentEnvironmentId() ?? 'unknown',
    paths,
    destinationPath,
    isWorktreeDirty,
    buildWorktreeBundle,
    bundleOptions: {
      includeSourceBranch: a.includeSourceBranch === true,
      knownTips: Array.isArray(a.knownTips) ? a.knownTips.filter((t): t is string => typeof t === 'string') : [],
    },
    carryWorktree: a.carryWorktree === true,
    persistSealPending: (sealPending) => {
      persistSealPendingOnTabsFile(paths.tabsFile, tabId, sealPending)
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sealPending } : t)),
      }))
    },
    releaseSealPending: (sealPending) => { releaseSeal(tabId, sealPending.since, paths) },
    resourceStateFor,
    exportResources: (conversationIds) => exportExtensionResources(defaultResourceWire(), tabId, conversationIds),
  })

  if (!result.ok) {
    const code: ExportRefusalCode = result.refusal.code
    return refusalOutcome(code, result.refusal.message)
  }

  // The client's id when it chose one, so it can listen before it asks.
  const requested = str(a, 'transferId')
  const transferId = UUID_PATTERN.test(requested) ? requested : randomUUID()
  if (requested && transferId !== requested) warn('export: requested transfer id is not a uuid; minted one', { tab_id: tabId, requested_length: requested.length })
  setImmediate(() => {
    void streamArchiveToConnection(conn, transferId, result.archivePath)
  })
  log('export accepted', { tab_id: tabId, target_environment_id: targetEnvironmentId, transfer_id: transferId, client_chose_id: transferId === requested, total_bytes: result.totalBytes })
  return { ok: true, value: { transferId, totalBytes: result.totalBytes, rootConversationId: result.rootConversationId, sealedAt: result.sealedAt } }
}

async function handleTransferImport(conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const transferId = str(a, 'transferId')
  const landing = parseLanding(a.landing)
  const totalBytes = num(a, 'totalBytes')
  if (!transferId || totalBytes <= 0) {
    return { ok: false, error: { code: 'invalid_args', message: 'transferId and a positive totalBytes are required' } }
  }

  const paths = defaultTransferPaths(currentPrincipal()?.subject)
  const archivePath = join(transferOutboxDir(paths), `inbound-${transferId}.zip`)

  // Registered synchronously (no await above this line since the arg checks
  // are pure) so a chunk arriving right after this action frame cannot race it.
  let receivedArchivePath: string
  try {
    receivedArchivePath = await registerInboundTransfer(transferId, archivePath, totalBytes, conn.id)
  } catch (err) {
    warn('import: inbound transfer aborted before completion', { transfer_id: transferId, error: String(err) })
    return { ok: false, error: { code: 'transfer_aborted', message: String(err) } }
  }

  let adoptedForResources: string | null = null
  try {
    const result = await runTransferImport({
      ...(landing ? { landing } : {}),
      archivePath: receivedArchivePath,
      paths,
      callerSubject: conn.principal?.subject ?? 'unknown',
      checkoutWorktreeFromBundle,
      worktreesOffered: deriveEnvironmentDeveloperSurfaces(enterprisePolicyCache.policy).worktrees,
      // The producers load in the tab's own session, so the tab joins the
      // live store first. On a refusal the import is undone and the tab
      // leaves the store again below.
      importResources: async ({ tabId, conversationIds, items }) => {
        adoptedForResources = tabId
        await adoptImportedTab(paths.tabsFile, tabId)
        const outcome = await importExtensionResources(defaultResourceWire(), tabId, conversationIds, items)
        return outcome.ok ? { ok: true } : outcome
      },
    })
    if (!result.ok) {
      if (adoptedForResources) {
        // The import was undone after the tab joined the live store: take it
        // out again, and stop the session its producers were loaded in.
        const undone = adoptedForResources
        useSessionStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== undone) }))
        await engineBridge.stopSession(undone).catch((err: unknown) => warn('import: stopping the undone tab\'s session failed', { tab_id: undone, error: String(err) }))
        log('import undone: tab removed from the live store', { transfer_id: transferId, tab_id: undone, refusal: result.refusal.code })
      }
      const code: ImportRefusalCode = result.refusal.code
      return refusalOutcome(code, result.refusal.message)
    }
    log('import complete', { transfer_id: transferId, root_conversation_id: result.rootConversationId, tab_id: result.tabId })
    mergeResourceState(result.resourceState)
    seedImportedCharts(result.conversationIds)
    await adoptImportedTab(paths.tabsFile, result.tabId)
    if (result.restoredWorktree) {
      // A checkout made from a bundle has no gitignored build state, so it
      // is provisioned like any new worktree. An untrusted project refuses
      // it here, and trusting the project catches it up.
      const { repoPath, worktreePath } = result.restoredWorktree
      log('import: provisioning the restored worktree', { transfer_id: transferId, repo_path: repoPath, worktree_path: worktreePath })
      void startWorktreeProvisioning(repoPath, worktreePath)
    } else {
      log('import: no new worktree to provision', { transfer_id: transferId, worktree_path: result.worktreePath ?? '' })
    }
    return { ok: true, value: { rootConversationId: result.rootConversationId, tabId: result.tabId, worktreePath: result.worktreePath } }
  } finally {
    try {
      rmSync(receivedArchivePath, { force: true })
    } catch (err) {
      warn('import temp archive cleanup failed', { archive_path: receivedArchivePath, error: String(err) })
    }
  }
}

/**
 * `transfer.remove` on the SOURCE: delete everything this host held for the
 * tab, now that the destination has verified its copy. This is what makes a
 * transfer a move — see `remove-source.ts` for the two guards that keep it
 * from deleting anything a transfer did not put in flight.
 */
async function handleTransferRemove(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const tabId = str(a, 'tabId')
  const targetEnvironmentId = str(a, 'targetEnvironmentId')
  if (!tabId || !targetEnvironmentId) {
    return { ok: false, error: { code: 'invalid_args', message: 'tabId and targetEnvironmentId are required' } }
  }
  const retireWorktree = a.retireWorktree === true
  const result = await removeTransferredSource({ tabId, targetEnvironmentId, retireWorktree, paths: defaultTransferPaths(principalSubjectForTab(tabId)) })
  if (!result.ok) return refusalOutcome(result.refusal.code, result.refusal.message)

  // The producers drop the resources they held for the moved conversations.
  // The destination already holds its own copies, so a failure here is
  // logged, not raised: the move itself is complete.
  if (result.removedConversations.length > 0) {
    await forgetExtensionResources(defaultResourceWire(), tabId, result.removedConversations)
  }

  // The record is already off disk; drop it from the live store so every
  // connected client's tab list loses the row in the same breath.
  useSessionStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== tabId) }))
  forgetMovedCharts(result.removedConversations)
  log('source removed', { tab_id: tabId, target_environment_id: targetEnvironmentId, retire_worktree: retireWorktree, conversation_count: result.removedConversations.length, worktree_path: result.removedWorktreePath ?? '', already_gone: result.alreadyGone })
  return { ok: true, value: { removedConversations: result.removedConversations, removedWorktreePath: result.removedWorktreePath, alreadyGone: result.alreadyGone } }
}

/** Clears the mark one export set, on disk and in the live store. False when the mark is no longer that one. */
function releaseSeal(tabId: string, sealedAt: number, paths: ReturnType<typeof defaultTransferPaths>): boolean {
  const result = releaseExportSeal({ tabId, sealedAt, paths })
  if (!result.ok || !result.released) return false
  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sealPending: null } : t)),
  }))
  return true
}

/**
 * `transfer.release` on the SOURCE: the client that asked for an export
 * never got its archive (it cancelled, or the download failed), so nothing
 * reached the destination. Undoes that export's own mark and nothing else,
 * which is why it needs only the scope the export itself needs.
 */
async function handleTransferRelease(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const tabId = str(a, 'tabId')
  const sealedAt = num(a, 'sealedAt')
  if (!tabId || !sealedAt) return { ok: false, error: { code: 'invalid_args', message: 'tabId and sealedAt are required' } }
  const released = releaseSeal(tabId, sealedAt, defaultTransferPaths(principalSubjectForTab(tabId)))
  return { ok: true, value: { released } }
}

async function handleTransferAbandon(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const tabId = str(a, 'tabId')
  if (!tabId) return { ok: false, error: { code: 'invalid_args', message: 'tabId is required' } }

  const result = abandonPendingTransfer({ tabId, paths: defaultTransferPaths(principalSubjectForTab(tabId)) })
  if (!result.ok) return refusalOutcome(result.refusal.code, result.refusal.message)

  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, sealPending: null } : t)),
  }))
  return { ok: true, value: null }
}

/**
 * The project a plain conversation's working directory belongs to, shaped
 * for the dialog. `repoRemote` empty means the directory belongs to no
 * registered project with an origin — nothing for the destination to
 * resolve by, so the operator is asked where it should land.
 */
async function describePlainProject(workingDirectory: string, paths: ReturnType<typeof defaultTransferPaths>): Promise<NonNullable<TransferDescription['project']>> {
  const empty = { workingDirectory, repoRemote: '', originUrl: '', suggestedParentDir: '' }
  const projectDir = projectDirContaining(workingDirectory, projectsIoFor(paths.settingsFile).readProjects)
  if (!projectDir) {
    log('describe: working directory belongs to no registered project', { working_directory: workingDirectory })
    return empty
  }
  const repoRemote = await ensureRepoRemote(projectDir, projectsIoFor(paths.settingsFile))
  if (!repoRemote) {
    log('describe: project has no origin to resolve by', { project_dir: projectDir })
    return empty
  }
  let originUrl = ''
  try { originUrl = (await runGit(projectDir, ['remote', 'get-url', 'origin'])).trim() } catch (err) { warn('describe: origin url unavailable', { repo_path: projectDir, error: String(err) }) }
  const home = homedir()
  const parent = dirname(projectDir)
  const suggestedParentDir = parent === home ? '~' : parent.startsWith(`${home}/`) ? `~/${parent.slice(home.length + 1)}` : parent
  const provisioning = declaredProvisioning(projectDir)
  return { workingDirectory, repoRemote, originUrl, suggestedParentDir, ...(provisioning ? { provisioning } : {}) }
}


/** The registered project that contains `dir`, longest match first (a project inside a project wins). */
function projectDirContaining(dir: string, readProjects: () => Record<string, { repoRemote?: string }>): string | null {
  if (!dir) return null
  const candidates = Object.keys(readProjects())
    .filter((projectDir) => dir === projectDir || dir.startsWith(`${projectDir}/`))
    .sort((a, b) => b.length - a.length)
  return candidates[0] ?? null
}

/**
 * `transfer.describe` on the SOURCE: what a transfer of `tabId` would carry,
 * so the dialog can ask the destination the right preflight questions
 * before anything is exported. Null `worktree` means a plain conversation.
 */
async function handleTransferDescribe(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const tabId = str(firstArgObject(args), 'tabId')
  if (!tabId) return { ok: false, error: { code: 'invalid_args', message: 'tabId is required' } }
  const liveTab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
  if (!liveTab) return refusalOutcome('not_found', `no open tab ${tabId}`)
  const paths = defaultTransferPaths(principalSubjectForTab(tabId))
  // The export will need every conversation's parent link; start reading
  // them now, while the operator is still looking at the dialog.
  warmParentIndex(paths.conversationsDir)
  if (!liveTab.worktree) {
    // A plain conversation's identity is its project, not its path: the
    // path is meaningless on the destination, and the repository is what
    // resolves to a directory over there.
    const project = await describePlainProject(liveTab.workingDirectory, paths)
    log('describe: plain conversation', { tab_id: tabId, working_directory: liveTab.workingDirectory, repo_remote: project.repoRemote, resolved: !!project.repoRemote })
    return { ok: true, value: { status: liveTab.status, worktree: null, project, archiveVersion: TRANSFER_MANIFEST_VERSION } }
  }
  const repoRemote = await ensureRepoRemote(liveTab.worktree.repoPath, projectsIoFor(paths.settingsFile))
  let originUrl = ''
  try { originUrl = (await runGit(liveTab.worktree.repoPath, ['remote', 'get-url', 'origin'])).trim() } catch (err) { warn('describe: origin url unavailable', { repo_path: liveTab.worktree.repoPath, error: String(err) }) }
  const dirty = await isWorktreeDirty(liveTab.worktree.worktreePath)
  // Where a clone of this repo would go on another host: the same place
  // relative to home when the source checkout lives under home.
  const home = homedir()
  const parent = dirname(liveTab.worktree.repoPath)
  const suggestedParentDir = parent === home ? '~' : parent.startsWith(`${home}/`) ? `~/${parent.slice(home.length + 1)}` : parent
  // A worktree moves whole: every other open conversation in it goes too.
  const worktreePath = liveTab.worktree.worktreePath
  const siblings = useSessionStore.getState().tabs
    .filter((t) => t.id !== tabId && t.worktree?.worktreePath === worktreePath)
    .map((t) => ({ tabId: t.id, title: t.customTitle || t.title }))
  log('describe: worktree conversation', { tab_id: tabId, repo_remote: repoRemote ?? '', dirty, suggested_parent_dir: suggestedParentDir, sibling_count: siblings.length })
  // A worktree conversation can also move on its own, and then it resolves
  // its destination exactly like a plain one: by the repository the
  // worktree belongs to.
  const provisioning = declaredProvisioning(liveTab.worktree.repoPath)
  const declared = provisioning ? { provisioning } : {}
  const project = repoRemote
    ? { workingDirectory: liveTab.workingDirectory, repoRemote, originUrl, suggestedParentDir, ...declared }
    : null
  return { ok: true, value: { status: liveTab.status, archiveVersion: TRANSFER_MANIFEST_VERSION, project, worktree: { repoRemote, branch: liveTab.worktree.branchName, sourceBranch: liveTab.worktree.sourceBranch, repoPath: liveTab.worktree.repoPath, originUrl, dirty, suggestedParentDir, siblings, ...declared } } }
}

/**
 * `transfer.preflight` on the DESTINATION: can it take this conversation?
 *
 * For a worktree: the matching project, whether the source branch exists
 * there, its branch tips (so the source bundles only what is missing), and
 * the project's setup state — `sourceBranch` is required for those answers.
 *
 * For a plain conversation: which directory it would land in. Called with
 * `repoRemote` alone, or with neither when the source could not resolve one,
 * in which case the whole project list comes back and the operator picks.
 */
async function handleTransferPreflight(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const repoRemote = str(a, 'repoRemote')
  const sourceBranch = str(a, 'sourceBranch')
  const branch = str(a, 'branch')
  const sourceDirectory = str(a, 'sourceDirectory')
  const paths = defaultTransferPaths(undefined)
  const readProjects = projectsIoFor(paths.settingsFile).readProjects
  const allProjectDirs = Object.keys(readProjects()).sort()
  const sourceDirectoryExists = !!sourceDirectory && existsSync(sourceDirectory)
  const projectDirs = repoRemote ? projectPathsByRepoRemote(repoRemote, readProjects) : []
  const projectDir = projectDirs[0] ?? null
  if (!projectDir) {
    log('preflight: no project for repo', { repo_remote: repoRemote, project_count: allProjectDirs.length, source_directory_exists: sourceDirectoryExists })
    const value: TransferPreflight = { projectDir: null, projectDirs: [], allProjectDirs, sourceDirectoryExists, hasSourceBranch: false, knownTips: [], worktreeCopy: null, archiveVersion: TRANSFER_MANIFEST_VERSION }
    return { ok: true, value }
  }
  let knownTips: string[] = []
  let hasSource = false
  // Only a worktree transfer names a source branch; a plain conversation
  // needs the directory and nothing else, and its preflight must not fail
  // on a git query it has no use for.
  if (sourceBranch) {
    try {
      ;[knownTips, hasSource] = await Promise.all([branchTips(projectDir), hasBranch(projectDir, sourceBranch)])
    } catch (err) {
      warn('preflight: git query failed', { project_dir: projectDir, error: String(err) })
    }
  }
  // Does this machine already hold a checkout of the worktree branch? A
  // checkout here means the branch is already home on this machine.
  let worktreeCopy: TransferPreflight['worktreeCopy'] = null
  if (branch) {
    try {
      const copyPath = await worktreePathForBranch(projectDir, branch)
      if (copyPath) {
        worktreeCopy = { worktreePath: copyPath, dirty: await isWorktreeDirty(copyPath) }
        log('preflight: this machine holds a copy of the branch', { branch, worktree_path: copyPath, dirty: worktreeCopy.dirty })
      } else {
        log('preflight: no copy of the branch here', { branch, project_dir: projectDir })
      }
    } catch (err) {
      warn('preflight: worktree copy check failed', { project_dir: projectDir, branch, error: String(err) })
    }
  }
  const value: TransferPreflight = { projectDir, projectDirs, allProjectDirs, sourceDirectoryExists, hasSourceBranch: hasSource, knownTips, worktreeCopy, archiveVersion: TRANSFER_MANIFEST_VERSION }
  log('preflight answered', { repo_remote: repoRemote, project_dir: projectDir, has_source_branch: hasSource, known_tips: knownTips.length, has_copy: !!worktreeCopy })
  return { ok: true, value }
}

/**
 * `transfer.landings` on the DESTINATION: what one of its projects offers a
 * conversation to land in — its live worktrees and the branches a new one
 * could be cut from. Asked per project, because the dialog's project choice
 * decides which worktrees are worth listing.
 */
async function handleTransferLandings(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const projectDir = str(firstArgObject(args), 'projectDir')
  if (!projectDir) return { ok: false, error: { code: 'invalid_args', message: 'projectDir is required' } }
  const result = await landingOptionsFor(projectDir, {
    ...defaultLandingDeps(defaultTransferPaths(undefined)),
    listBranches: async (dir) => (await runGit(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').map((l) => l.trim()).filter((l) => l.length > 0).sort(),
    currentBranch: async (dir) => (await runGit(dir, ['branch', '--show-current'])).trim() || null,
  })
  if (!result.ok) return refusalOutcome('not_found', result.message)
  return { ok: true, value: result.value }
}

/**
 * `transfer.relocate` on the machine the conversation already lives on:
 * move it to another checkout or worktree here. No archive; the tab and its
 * live session are repointed together (`relocate.ts`).
 */
async function handleTransferRelocate(_conn: Connection, args: unknown[]): Promise<TransferActionOutcome> {
  const a = firstArgObject(args)
  const tabId = str(a, 'tabId')
  const landing = parseLanding(a.landing)
  if (!tabId || !landing) return { ok: false, error: { code: 'invalid_args', message: 'tabId and a landing are required' } }
  const store = useSessionStore
  const result = await runRelocate(tabId, landing, {
    ...defaultLandingDeps(defaultTransferPaths(principalSubjectForTab(tabId))),
    findTab: (id) => store.getState().tabs.find((t) => t.id === id) ?? null,
    busyGuard: (id) => evaluateSessionBusyGuard(store.getState().conversationPanes.get(id)),
    repoint: (id, dir, worktree) => setTabWorkingDirectory(store.setState, store.getState, id, dir, { worktree }),
  })
  if (!result.ok) return refusalOutcome(result.refusal.code, result.refusal.message)
  return { ok: true, value: result }
}

export const TRANSFER_ACTIONS: Record<string, TransferActionSpec> = {
  'transfer.describe': { requiredScope: 'conversations:read', handler: handleTransferDescribe },
  'transfer.preflight': { requiredScope: 'conversations:read', handler: handleTransferPreflight },
  'transfer.landings': { requiredScope: 'conversations:read', handler: handleTransferLandings },
  'transfer.export': { requiredScope: 'conversations:operate', handler: handleTransferExport },
  'transfer.import': { requiredScope: 'conversations:operate', handler: handleTransferImport },
  'transfer.remove': { requiredScope: 'conversations:operate', handler: handleTransferRemove },
  'transfer.relocate': { requiredScope: 'conversations:operate', handler: handleTransferRelocate },
  'transfer.abandon': { requiredScope: 'admin', handler: handleTransferAbandon },
  'transfer.release': { requiredScope: 'conversations:operate', handler: handleTransferRelease },
}
