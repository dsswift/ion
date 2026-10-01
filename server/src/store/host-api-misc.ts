import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { describeFile } from '../files/describe-file'
import { loadSession as loadSessionReal } from './session-reads'
/**
 * HostApi terminal/resource/misc domain — see `host-api-engine.ts` for the
 * module-level explanation of what this file replaces and why.
 *
 * Tab, tab-content, session-label, session-chain, and stored-conversation
 * persistence is real logic here (backed by `persistence/settings-store.ts`,
 * `persistence/tab-content-store.ts`, the tab-migration runners, and the
 * engine bridge) — it used to be a set of no-op stubs left for a later child
 * to wire, until the Overlay renderer that used to persist this state via
 * Electron IPC (`main/ipc/settings.ts`) was removed, making the server the
 * sole remaining place this state can be saved.
 *
 * The REMAINING no-ops in this file each have a comment explaining what
 * their real desktop-side implementation needs (a `BrowserWindow`, the
 * Studio wire from child 07, or similar) — NOT stubs standing in for logic
 * that could be moved today. Each is a genuine capability gap a later child
 * in this program closes.
 */
import { isValidProjectPath } from '../ipc-validation'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { debug, info, warn, error } from '../logger'
import { terminalScrollback, bashProcesses, sessionPlane, engineBridge } from '../state'
import { getCliEnv } from '../cli-env'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { tabsFile, settingsDir, loadSessionLabels, saveSessionLabels, loadSessionChains as loadChainsFromDisk, saveSessionChains as saveChainsToDisk } from '../persistence/settings-store'
import { runTabBackendMerge } from '../persistence/tab-backend-merge'
import { runTabUnifyMigration } from '../persistence/tab-migration-unify-runner'
import { runTabSplitMigration } from '../persistence/tab-migration-split-runner'
import { runTabExternalizeMigration } from '../persistence/tab-migration-externalize-runner'
import { loadInstanceContent, saveInstanceContent, deleteInstanceContent, mergeExternalContent, hasInstanceContent } from '../persistence/tab-content-store'
import type { SessionLoadMessage, FileAttachment } from '@ion/shared/types-session'
import type { ExternalInstanceContent, PersistedTabState } from '@ion/shared/types-persistence'
import { nextWorktreeRevision, nextTerminalRevision } from './studio-revisions'
import { markReadPersisted } from '../engine/event-wiring-resource-state'
import { publishResourceMarkRead } from '../engine/event-wiring-resources'
import { sendRemoteEvent, remoteClientsPresent } from '../thin-view/remote-out'
import { commandShell } from '../terminal/terminal-shell'
import { pathBasename } from '@ion/shared/paths'

/**
 * The tab manifest's safety net against a truncated save -- a bug that
 * writes fewer tabs than the operator actually has -- must never mistake a
 * deliberate close for that bug. The two used to be told apart by COUNT
 * (a save dropping more than half of ten-plus tabs was refused; a primary
 * file with fewer than ten tabs lost to a fuller `.prev` at boot), which
 * resurrected every conversation deleted on a small install as soon as the
 * server restarted: delete one of two tabs, restart, and both are back --
 * the deleted one now without its content file. Observed on the first
 * Oscar deploy.
 *
 * The precise signal is on disk already. Closing or deleting a tab removes
 * its externalized content file (`deleteInstanceContent`) before the
 * manifest is saved; a truncated save does not. So a tab that vanished
 * from the manifest while its content file remains is exactly a tab whose
 * messages would be lost, and only those trip the guard. A tab without a
 * content file has no messages to lose either way.
 */
/**
 * Every tab id a manifest still accounts for: the open tabs AND the settled
 * history. A settled conversation leaves `tabs` but keeps its record (and
 * its content file, for read-only review), so a guard that read only `tabs`
 * saw every settle as an orphaning save and refused it -- and every save
 * after it, since the settled record's content file never goes away. The
 * operator's settle came back on the next boot, and the tab created after
 * it was never persisted at all.
 */
function manifestTabIds(data: unknown): string[] {
  const d = data as { tabs?: unknown; settledHistory?: unknown } | null | undefined
  return [...tabIds(d?.tabs), ...tabIds(d?.settledHistory)]
}

function readOnDiskTabIds(): string[] {
  try {
    if (existsSync(tabsFile())) {
      return manifestTabIds(JSON.parse(readFileSync(tabsFile(), 'utf-8')))
    }
  } catch (err) {
    debug('tabs', 'on-disk tab ids read failed', { error: String(err) })
  }
  return []
}

/** Tabs present in `before` but absent from `after` whose content file is still on disk -- the ones a truncated save would lose. */
export function droppedTabsWithContent(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after)
  return before.filter((id) => !kept.has(id) && hasInstanceContent(id))
}

function tabIds(tabs: unknown): string[] {
  return Array.isArray(tabs) ? tabs.map((t: { id?: unknown }) => (typeof t?.id === 'string' ? t.id : '')).filter(Boolean) : []
}

export { listEngineDirectory, getEngineHostInfo, engineIsRemote } from '../engine/engine-bridge-fs'

export function sendRemote(event: unknown): void {
  sendRemoteEvent(event as never)
}

export async function terminalCreate(key: string, cwd: string) {
  const { terminalManager } = await import('../terminal/terminal-manager-instance')
  return terminalManager.create(key, cwd)
}

export async function terminalRelaunch(key: string, cwd: string): Promise<void> {
  const { terminalManager } = await import('../terminal/terminal-manager-instance')
  await terminalManager.relaunch(key, cwd)
}

export async function terminalDestroy(key: string): Promise<void> {
  const { terminalManager } = await import('../terminal/terminal-manager-instance')
  terminalManager.destroy(key)
}

export async function terminalWrite(key: string, data: string): Promise<void> {
  const { terminalManager } = await import('../terminal/terminal-manager-instance')
  terminalManager.write(key, data)
}

export async function terminalAttach(key: string, opts?: { restartIfNotRunning?: boolean; cwd?: string }) {
  const { terminalManager } = await import('../terminal/terminal-manager-instance')
  return terminalManager.attach(key, opts)
}

export function getTerminalScrollback(key: string): string {
  return terminalScrollback.get(key) ?? ''
}

export function setSavedBuffer(_key: string, _buffer: string): void {
  // Staged for the FIRST MOUNT of a real xterm.js Terminal component
  // (desktop/src/renderer/components/TerminalInstance.tsx), which the server
  // does not render. No-op until a Studio client's terminal view (child 07)
  // needs its own restore-buffer handoff.
}

export function cancelBash(execId: string): void {
  const child = bashProcesses.get(execId)
  if (child) {
    child.kill('SIGINT')
  }
}

export function executeBash(execId: string, command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const runner = commandShell(command)
    const child = spawn(runner.shell, runner.args, { cwd, env: getCliEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    bashProcesses.set(execId, child)

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('close', (code) => {
      bashProcesses.delete(execId)
      sessionPlane.notifyExternalWorkDone()
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
      })
    })

    child.on('error', (err) => {
      bashProcesses.delete(execId)
      sessionPlane.notifyExternalWorkDone()
      resolve({ stdout: '', stderr: err.message, exitCode: 1 })
    })
  })
}

/**
 * A resource was read on this client. The caller has already updated its
 * in-memory `readResourceIds`; this persists the read identity (the client
 * source of truth that reconnecting devices are seeded from) and fans the
 * mark_read delta through the engine's resource broker so every subscriber,
 * iOS included, converges. The same two steps the desktop's
 * MARK_RESOURCE_READ IPC handler performed.
 */
export function markResourceRead(kind: string, resourceId: string, producer?: string): void {
  markReadPersisted(resourceId, producer, kind)
  publishResourceMarkRead(kind, resourceId, producer).catch((err) => {
    warn('host-api', 'resource_mark_read: publish failed', { kind, resource_id: resourceId, producer: producer ?? '', error: String(err) })
  })
}

export function isVisible(): Promise<boolean> {
  // The server has no window to be visible or hidden; treated as always
  // visible so idle-detection logic that gates on "is anyone looking" degrades
  // to "assume yes" rather than silently suppressing notifications.
  return Promise.resolve(true)
}

export function openExternal(_url: string): Promise<void> {
  // Opening a URL in a local browser is a client-device concern (desktop
  // Electron `shell.openExternal`); the server has no local UI to open one
  // from. A Studio client handles its own `openExternal` locally.
  return Promise.resolve()
}

export function selectDirectory(): Promise<string | null> {
  // A native directory picker requires a window; the Studio wire (child 07)
  // routes this to the requesting client instead of resolving it server-side.
  return Promise.resolve(null)
}

export function readPlan(planFilePath: string): Promise<{ content: string | null; fileName: string | null }> {
  // Matches the desktop IPC contract (main/ipc/sessions-list.ts READ_PLAN):
  // callers destructure `{ content, fileName }`, not a bare string.
  if (!isValidProjectPath(planFilePath)) return Promise.resolve({ content: null, fileName: null })
  try {
    const content = readFileSync(planFilePath, 'utf-8')
    const fileName = pathBasename(planFilePath)
    return Promise.resolve({ content, fileName })
  } catch {
    return Promise.resolve({ content: null, fileName: null })
  }
}

export interface PlanImplementedPayload {
  tabId: string
  worktreePath: string
  repoPath: string
  branchName: string
  sourceBranch: string
  planFilePath: string
  clearContext: boolean
  source: 'renderer' | 'remote'
}

/**
 * Matches the desktop IPC contract (main/ipc/automation.ts
 * AUTOMATION_PLAN_IMPLEMENTED): validate, then forward to the automation
 * runtime's two-arg `(tabId, payload)` trigger — already server-side in
 * `automation/runtime.ts`, same call this makes from
 * `remote/handlers/implement-plan.ts` for the iOS/remote path.
 */
export async function triggerPlanImplemented(payload: PlanImplementedPayload): Promise<void> {
  const { getAutomationRuntime } = await import('../automation/runtime')
  await getAutomationRuntime().triggerPlanImplemented(payload.tabId, { ...payload })
}

export function attachFileByPath(path: string): Promise<FileAttachment | null> {
  // Implemented for real now: nothing about describing a file needs Electron,
  // only a filesystem, and the server has one. This used to return a hardcoded
  // null on the reasoning that the "desktop-side filesystem/thumbnail plumbing
  // has not moved server-side yet" -- which meant a browser client could not
  // attach a file the server could read perfectly well.
  //
  // `null` remains the answer for a path that cannot be described (missing,
  // unreadable, not a file); `describeFile` logs before returning it.
  return Promise.resolve(describeFile(path) as FileAttachment | null)
}

/**
 * Load the persisted tab manifest, running the one-time on-disk migrations
 * (backend merge -> unify -> split -> externalize) ahead of the read, then
 * recovering from the `.prev` rolling backup when the primary file looks
 * truncated (a tab `.prev` lists is missing while its content file is still
 * on disk -- see {@link droppedTabsWithContent}). Ported from the desktop's
 * former Electron IPC handler
 * (`main/ipc/settings.ts` IPC.LOAD_TABS) — the server is now the sole reader
 * since nothing calls that IPC handler anymore (see `AGENTS.md` "Dead code
 * is not load-bearing until proven otherwise": the handler had no caller
 * left once the Overlay renderer that used to invoke `window.ion.loadTabs`
 * was removed).
 */
export function loadTabs(): Promise<PersistedTabState | null> {
  const PREV_FILE = tabsFile() + '.prev'
  try {
    const mergeOutcome = runTabBackendMerge()
    if (mergeOutcome.reason === 'success') {
      info('tabs', 'backend merge applied', { ...mergeOutcome.tabCounts, path: tabsFile() })
    } else if (mergeOutcome.reason === 'error') {
      info('tabs', 'backend merge not applied', { reason: mergeOutcome.reason, error: mergeOutcome.errorMessage })
    }
  } catch (err) {
    error('tabs', 'backend merge error', { error: (err as Error).message })
  }
  try {
    const primaryOutcome = runTabUnifyMigration(tabsFile())
    if (primaryOutcome.reason === 'success') {
      info('tabs', 'unify migration applied', { path: tabsFile(), tab_count: primaryOutcome.tabCount, backup: primaryOutcome.backupPath })
    } else if (primaryOutcome.reason === 'verify-failed' || primaryOutcome.reason === 'error') {
      info('tabs', 'unify migration not applied', { path: tabsFile(), reason: primaryOutcome.reason, error: primaryOutcome.errorMessage })
    }
    if (existsSync(PREV_FILE)) runTabUnifyMigration(PREV_FILE)
  } catch (err) {
    error('tabs', 'unify migration error', { error: (err as Error).message })
  }
  try {
    const splitOutcome = runTabSplitMigration(tabsFile())
    if (splitOutcome.reason === 'success') {
      info('tabs', 'split migration applied', { path: tabsFile(), tabs_before: splitOutcome.tabsBefore, tabs_after: splitOutcome.tabsAfter, backup: splitOutcome.backupPath })
    } else if (splitOutcome.reason === 'verify-failed' || splitOutcome.reason === 'error') {
      info('tabs', 'split migration not applied', { path: tabsFile(), reason: splitOutcome.reason, error: splitOutcome.errorMessage })
    }
    if (existsSync(PREV_FILE)) runTabSplitMigration(PREV_FILE)
  } catch (err) {
    error('tabs', 'split migration error', { error: (err as Error).message })
  }
  try {
    const extOutcome = runTabExternalizeMigration(tabsFile())
    if (extOutcome.reason === 'success') {
      info('tabs', 'externalize migration applied', { path: tabsFile(), content_files: extOutcome.contentFiles, backup: extOutcome.backupPath })
    } else if (extOutcome.reason === 'verify-failed' || extOutcome.reason === 'error') {
      info('tabs', 'externalize migration not applied', { path: tabsFile(), reason: extOutcome.reason, error: extOutcome.errorMessage })
    }
  } catch (err) {
    error('tabs', 'externalize migration error', { error: (err as Error).message })
  }
  try {
    let primary: PersistedTabState | null = null
    let primaryCount = 0
    if (existsSync(tabsFile())) {
      primary = JSON.parse(readFileSync(tabsFile(), 'utf-8'))
      primaryCount = Array.isArray(primary?.tabs) ? primary!.tabs.length : 0
    }
    if (existsSync(PREV_FILE)) {
      try {
        const prev = JSON.parse(readFileSync(PREV_FILE, 'utf-8'))
        const prevCount = Array.isArray(prev?.tabs) ? prev.tabs.length : 0
        // Settled records count as kept here too: a primary written right
        // after a settle lists that tab under settledHistory, not tabs, and
        // must not read as a truncation that .prev should overrule.
        const orphaned = droppedTabsWithContent(manifestTabIds(prev), manifestTabIds(primary))
        if (orphaned.length > 0) {
          info('tabs', 'startup recovery, using .prev', { primary_count: primaryCount, prev_count: prevCount, orphaned_tab_ids: orphaned })
          return Promise.resolve(prev)
        }
        if (prevCount > primaryCount) {
          debug('tabs', 'primary lists fewer tabs than .prev; every missing tab has no content on disk, so the primary is trusted', { primary_count: primaryCount, prev_count: prevCount })
        }
      } catch (err) {
        error('tabs', 'failed to read .prev during startup recovery', { error: String(err) })
      }
    }
    if (primary) {
      try {
        const tabs = Array.isArray(primary.tabs) ? primary.tabs : []
        const activeIdx = typeof (primary as { activeTabIndex?: number }).activeTabIndex === 'number' ? (primary as { activeTabIndex: number }).activeTabIndex : -1
        const activeTabId: string | undefined = tabs[activeIdx]?.id
        if (activeTabId) {
          primary = mergeExternalContent(primary, loadInstanceContent, (id) => id === activeTabId)
        }
      } catch (err) {
        error('tabs', 'active-tab content merge failed', { error: (err as Error).message })
      }
      info('tabs', 'loaded', { count: primaryCount, path: tabsFile() })
      return Promise.resolve(primary)
    }
  } catch (err) {
    error('tabs', 'load failed', { error: String(err) })
  }
  return Promise.resolve(null)
}

/**
 * Persist the tab manifest with a three-layer safety net (guard against a
 * save that would orphan a tab's content -- see {@link droppedTabsWithContent}
 * -- rolling `.prev` backup, atomic write). See {@link loadTabs}'s doc for
 * why this is now the server's own logic rather than IPC.
 */
export function saveTabs(data: PersistedTabState): Promise<void> {
  try {
    if (!existsSync(settingsDir())) mkdirSync(settingsDir(), { recursive: true })
    const incomingCount = Array.isArray(data?.tabs) ? data.tabs.length : 0
    const onDiskIds = readOnDiskTabIds()
    const orphaned = droppedTabsWithContent(onDiskIds, manifestTabIds(data))
    if (orphaned.length > 0) {
      const rejectedPath = tabsFile() + '.rejected'
      // WARN, not INFO: a refused save means nothing the operator does from
      // here on persists until the manifest accounts for these ids again.
      warn('tabs', 'guard refused save', { on_disk_count: onDiskIds.length, incoming_count: incomingCount, orphaned_tab_ids: orphaned, rejected_path: rejectedPath })
      atomicWriteFileSync(rejectedPath, JSON.stringify(data, null, 2), 0o644)
      return Promise.resolve()
    }
    if (existsSync(tabsFile())) {
      try {
        renameSync(tabsFile(), tabsFile() + '.prev')
      } catch {
        // Non-fatal — the .prev file may be locked or the FS may be slow.
      }
    }
    atomicWriteFileSync(tabsFile(), JSON.stringify(data, null, 2), 0o644)
    debug('tabs', 'saved', { count: incomingCount, path: tabsFile() })
  } catch (err) {
    error('tabs', 'save failed', { error: String(err) })
  }
  return Promise.resolve()
}

export function saveTabContent(tabId: string, instanceId: string, messages: unknown[]): Promise<void> {
  try {
    saveInstanceContent(tabId, instanceId, messages as never)
  } catch (err) {
    error('tabs', 'tab content save failed', { tab_id: tabId, error: String(err) })
  }
  return Promise.resolve()
}

export async function loadTabContent(tabId: string): Promise<ExternalInstanceContent | null> {
  // Externalized scrollback is plain on-disk JSON under
  // `~/.ion/tab-content/<tabId>.json` (schema v4) — already server-side in
  // `persistence/tab-content-store.ts`. No BrowserWindow or IPC involved, so
  // (unlike the genuine capability gaps documented at the top of this file)
  // this is real logic to wire, not a stub to leave typed loosely.
  return loadInstanceContent(tabId)
}

export function deleteTabContent(tabId: string): Promise<void> {
  deleteInstanceContent(tabId)
  return Promise.resolve()
}

/** Delegates to the engine bridge, which already has a real implementation (`engine-bridge.ts`'s `deleteStoredConversations`) — this was previously a no-op that the inbox slice's bulk-delete called with no effect. */
/** Throws when the engine refuses; the count is what actually left disk. */
export async function deleteStoredConversations(sessionIds: string[]): Promise<{ deleted: number }> {
  return engineBridge.deleteStoredConversations(sessionIds)
}

/** Delegates to the engine bridge's real `generateTitle` (`engine-bridge.ts`) — this was previously a no-op that silently produced an empty title on every auto-title request. */
export function generateTitle(source: string): Promise<string> {
  return engineBridge.generateTitle(source)
}

export function saveSessionLabel(conversationId: string, label: string | null): Promise<void> {
  const labels = loadSessionLabels()
  if (label) {
    labels[conversationId] = label
  } else {
    delete labels[conversationId]
  }
  saveSessionLabels(labels)
  return Promise.resolve()
}

/**
 * Used to hardcode an empty result regardless of `sessionId` -- reasonable
 * once, when this was Electron-bound plumbing waiting for the server-side
 * store split, but it never got wired to the real reader once that split
 * landed. The live cost: `useTabRestoration-history.ts` calls this to
 * restore the PRE-fork/rewind half of a conversation on every app restart
 * (`historicalSessionIds`), and `resume-slice.ts` calls it when adopting an
 * orphaned tab id -- both silently produced zero history instead of a real
 * error, and the loss was easy to miss because the tab's CURRENT messages
 * still loaded fine through a separate, working path.
 *
 * `session-reads.ts`'s `loadSession` is the real implementation (same
 * process now, no IPC round trip needed) -- session.load already exposes it
 * on the studio wire; this just stops shadowing it here.
 */
export function loadSession(sessionId: string, defaultDir: string, encodedDir?: string): Promise<SessionLoadMessage[]> {
  return loadSessionReal({ sessionId, projectPath: defaultDir, encodedDir }) as Promise<SessionLoadMessage[]>
}

export async function loadChainHistory(sessionIds: string[]): Promise<SessionLoadMessage[]> {
  const { sessionPlane } = await import('../state')
  return sessionPlane.loadChainHistory(sessionIds)
}

export interface SessionChains {
  chains: Record<string, string[]>
  reverse: Record<string, string>
}

export function loadSessionChains(): Promise<SessionChains> {
  return Promise.resolve(loadChainsFromDisk())
}

export function saveSessionChains(payload: SessionChains): Promise<void> {
  saveChainsToDisk(payload)
  return Promise.resolve()
}

/**
 * A tab field (title, customTitle, pillColor) changed.
 * Push a lightweight `desktop_tab_meta` delta to every connected client now,
 * instead of leaving it to the next structural snapshot. Null pill values
 * explicitly clear a customization; absent values leave it unchanged, so a
 * rename never wipes a pill. State itself was updated by the caller.
 */
export function tabMetaChanged(payload: { tabId: string; title?: string; runCostUsd?: number; totalCostUsd?: number; pillColor?: string | null}): void {
  if (!remoteClientsPresent()) return
  const { tabId, title, runCostUsd, totalCostUsd, pillColor } = payload
  const delta: Record<string, unknown> = { type: 'desktop_tab_meta', tabId }
  if (title !== undefined) delta.title = title
  if (runCostUsd !== undefined) {
    delta.runCostUsd = runCostUsd
    // Keep totalCostUsd for lockstep iOS compatibility until iOS migrates.
    delta.totalCostUsd = runCostUsd
  } else if (totalCostUsd !== undefined) {
    delta.totalCostUsd = totalCostUsd
  }
  if (pillColor !== undefined) delta.pillColor = pillColor
  info('tabs', 'tab_meta_changed: pushing desktop_tab_meta', {
    tab_id: tabId,
    title: title ?? '-',
    cost: runCostUsd ?? totalCostUsd ?? '-',
    pill_color: pillColor ?? '-',
  })
  sendRemoteEvent(delta as never)
}

/**
 * Owner-published mirror snapshots.
 *
 * These three were no-ops carrying the comment "no-op until the Studio wire
 * (child 07) lands". The Studio wire landed; the no-ops did not. The visible
 * consequence was that a browser Studio client's conversation terminal panel
 * never opened: `toggleTerminal` forwarded to the server, the server's store
 * flipped `terminalOpenTabIds`, and the snapshot that would have told the
 * client went nowhere -- so the panel stayed closed with the server insisting
 * it was open. The worktree inventory was blank for the same reason.
 *
 * `broadcast()` fans each to every attached Studio connection for the
 * channels in the wire contract; an Electron window gets the identical
 * payload over its own `webContents.send`.
 */
export function studioPublishTabsSync(payload: unknown): void {
  broadcast(IPC.STUDIO_TABS_SYNC, payload)
}

/*
 * Both of these stamp a revision the projector deliberately omits.
 *
 * The client keeps the highest revision it has seen and rejects a snapshot
 * without a safe-integer `revision` as malformed. Publishing the bare
 * projector output therefore meant every delta was dropped on arrival --
 * invisible on the Electron window, which pulls a stamped snapshot over IPC
 * instead, and total on a browser client, whose only source is these frames.
 */
export function studioPublishWorktreeSync(payload: unknown): void {
  broadcast(IPC.STUDIO_WORKTREE_SYNC, { ...(payload as object), revision: nextWorktreeRevision() })
}

export function studioPublishConversationTerminals(payload: unknown): void {
  broadcast(IPC.STUDIO_CONVERSATION_TERMINALS, { ...(payload as object), revision: nextTerminalRevision() })
}


export function respondElicitation(_tabId: string, _requestId: string, _response: unknown, _cancelled: boolean, _isPermission?: boolean): Promise<void> {
  return Promise.resolve()
}

// Startup progress rides the wire to the desktop splash: see startup-progress.ts.
export { reportStartup } from './startup-progress'

export function showDesktopNotification(_title: string, _body: string): void {
  // A native OS notification (Electron's `Notification`) needs a desktop
  // process and tray/notification-center access the server does not have.
  // No-op until a client-side notify path (the resource subsystem's
  // `ctx.notify()` push pipeline, or a client-owned notification handler
  // over the Studio wire from child 07) replaces this call site.
}

export function onQuestionsState(_cb: (snapshot: unknown) => void): () => void {
  return () => {}
}

export function on(_channel: string, _cb: (...args: unknown[]) => void): void {
  // Renderer-side event bus registration; the server has no local event
  // emitter equivalent for these UI-only channels (e.g. 'ion:models-updated').
}

export function onProviderLoginEvent(_cb: (update: import('@ion/shared/types-engine-event').ProviderLoginUpdate) => void): () => void {
  return () => {}
}

export function start(): Promise<{
  version: string
  auth: { email?: string; subscriptionType?: string; authMethod?: string }
  mcpServers: string[]
  projectPath: string
  homePath: string
}> {
  // Matches the desktop IPC contract (main/ipc/window.ts IPC.START).
  // `version` there comes from Electron's `app.getVersion()`; `auth` and
  // `mcpServers` come from desktop-only state populated elsewhere. Neither
  // has a server-side equivalent yet — a genuine capability gap, not logic
  // that could be moved today (see the module comment). `projectPath`/
  // `homePath` need no Electron and are real here.
  return Promise.resolve({
    version: 'unknown',
    auth: {},
    mcpServers: [],
    projectPath: process.cwd(),
    homePath: homedir(),
  })
}

