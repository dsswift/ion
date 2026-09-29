/**
 * Loads a project's committed `.ion/studio.json` for a conversation directory.
 *
 * ── Whose copy counts ───────────────────────────────────────────────────────
 * For a worktree conversation the caller passes the BASE repository (the same
 * authority `.ion/worktree.json` uses), so an uncommitted edit inside a
 * worktree cannot grant itself a shell command. For any other conversation the
 * config is looked for at the git toplevel of its directory, and never above
 * it: `~/.ion` is a real directory, and walking up past the repository would
 * let it answer for every project under the home folder.
 *
 * ── Trust ───────────────────────────────────────────────────────────────────
 * The operator approves a project's tool LIST, identified by its hash, once.
 * `trustedProjectQuickTools[root]` holds that hash. `resolveProjectQuickTool`
 * — the only path that hands out a command to run — re-reads the file and
 * refuses unless the current hash is the approved one, so a client showing a
 * stale list can never run a tool the operator has not seen.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import {
  PROJECT_STUDIO_CONFIG_CHANNEL,
  PROJECT_STUDIO_CONFIG_PATH,
  PROJECT_QUICK_TOOL_ID_PREFIX,
  parseProjectStudioConfig,
  projectQuickToolsCanonicalText,
  type ProjectQuickTool,
  type ProjectStudioConfigSnapshot,
} from '@ion/shared/project-studio-config'
import { isValidProjectPath } from './ipc-validation'
import { runGit } from './git/git-runner'
import { readSettings } from './persistence/settings-store'
import { persistAndBroadcastSettings } from './settings-broadcast'
import { broadcast } from './broadcast'
import { debug as _debug, log as _log, warn as _warn } from './logger'

const TAG = 'project-studio-config'
const SETTING_KEY = 'trustedProjectQuickTools'
const WATCH_DEBOUNCE_MS = 150

export function hashProjectQuickTools(tools: readonly ProjectQuickTool[]): string {
  return tools.length === 0 ? '' : createHash('sha256').update(projectQuickToolsCanonicalText(tools)).digest('hex')
}

/** The git toplevel of `directory`, or the directory itself outside a checkout. */
async function projectRootOf(directory: string): Promise<string> {
  try {
    const top = (await runGit(directory, ['rev-parse', '--show-toplevel'])).trim()
    return top || directory
  } catch (err) {
    _debug(TAG, 'not a git checkout; using the directory as the project root', { directory, error: String(err) })
    return directory
  }
}

function trustedHashes(): Record<string, string> {
  const raw = (readSettings() as Record<string, unknown>)[SETTING_KEY]
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {}
}

const watchers = new Map<string, FSWatcher>()

/** Announce edits to a project's config so open composers re-read it. One watcher per root. */
function watchRoot(root: string): void {
  if (watchers.has(root)) return
  const dir = join(root, '.ion')
  if (!existsSync(dir)) return
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const watcher = watch(dir, (_event, fileName) => {
      if (fileName !== 'studio.json') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        _log(TAG, 'project studio config changed on disk', { root })
        broadcast(PROJECT_STUDIO_CONFIG_CHANNEL, { root })
      }, WATCH_DEBOUNCE_MS)
    })
    watcher.on('error', (err) => {
      _warn(TAG, 'config watcher failed; changes will show on the next read', { root, error: String(err) })
      watcher.close()
      watchers.delete(root)
    })
    watchers.set(root, watcher)
  } catch (err) {
    _warn(TAG, 'could not watch the project config directory', { root, error: String(err) })
  }
}

/** Test seam: drop every watcher. */
export function closeProjectStudioConfigWatchers(): void {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
}

function readRoot(root: string): ProjectStudioConfigSnapshot {
  const file = join(root, PROJECT_STUDIO_CONFIG_PATH)
  if (!existsSync(file)) {
    _debug(TAG, 'no project studio config', { root })
    return { root: null, quickTools: [], toolsHash: '', trusted: false }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    _warn(TAG, 'project studio config is not valid JSON; granting nothing', { file, error: String(err) })
    return { root, quickTools: [], toolsHash: '', trusted: false, error: 'the file is not valid JSON' }
  }
  const parsed = parseProjectStudioConfig(raw)
  if ('error' in parsed) {
    _warn(TAG, 'project studio config refused; granting nothing', { file, reason: parsed.error })
    return { root, quickTools: [], toolsHash: '', trusted: false, error: parsed.error }
  }
  const toolsHash = hashProjectQuickTools(parsed.config.quickTools)
  const trusted = toolsHash !== '' && trustedHashes()[root] === toolsHash
  _log(TAG, 'project studio config loaded', { root, tools: parsed.config.quickTools.length, trusted })
  return { root, quickTools: parsed.config.quickTools, toolsHash, trusted }
}

/**
 * `directory` is the conversation's project directory: the base repository
 * for a worktree conversation, the working directory otherwise.
 */
export async function loadProjectStudioConfig(payload: unknown): Promise<ProjectStudioConfigSnapshot> {
  const directory = (payload as { directory?: unknown } | null)?.directory
  if (typeof directory !== 'string' || !isValidProjectPath(directory)) {
    _warn(TAG, 'load refused: invalid directory')
    return { root: null, quickTools: [], toolsHash: '', trusted: false, error: 'Invalid path' }
  }
  const root = await projectRootOf(directory)
  watchRoot(root)
  return readRoot(root)
}

/**
 * Record the operator's approval of exactly the list they were shown. The
 * approval is refused when the file has moved on since: what they approved is
 * no longer what would run.
 */
export async function trustProjectQuickTools(payload: unknown): Promise<{ trusted: boolean; reason?: string }> {
  const request = (payload ?? {}) as { directory?: unknown; toolsHash?: unknown }
  const snapshot = await loadProjectStudioConfig({ directory: request.directory })
  if (!snapshot.root || snapshot.toolsHash === '') return { trusted: false, reason: 'the project ships no tools' }
  if (snapshot.toolsHash !== request.toolsHash) {
    _warn(TAG, 'trust refused: the tool list changed since it was shown', { root: snapshot.root })
    return { trusted: false, reason: 'the tool list changed; review it again' }
  }
  // The single settings write funnel: merge into the whole document, never replace it.
  const prev = readSettings() as Record<string, unknown>
  persistAndBroadcastSettings({ ...prev, [SETTING_KEY]: { ...trustedHashes(), [snapshot.root]: snapshot.toolsHash } }, prev)
  _log(TAG, 'project quick tools trusted', { root: snapshot.root, tools: snapshot.quickTools.length })
  broadcast(PROJECT_STUDIO_CONFIG_CHANNEL, { root: snapshot.root })
  return { trusted: true }
}

/** The only path that hands out a project tool's command. Null (after logging why) unless it is trusted right now. */
export async function resolveProjectQuickTool(directory: string, storeToolId: string): Promise<ProjectQuickTool | null> {
  if (!storeToolId.startsWith(PROJECT_QUICK_TOOL_ID_PREFIX)) return null
  const snapshot = await loadProjectStudioConfig({ directory })
  const tool = snapshot.quickTools.find((t) => t.id === storeToolId.slice(PROJECT_QUICK_TOOL_ID_PREFIX.length))
  if (!tool) {
    _warn(TAG, 'project quick tool refused: not in the project config', { directory, tool_id: storeToolId })
    return null
  }
  if (!snapshot.trusted) {
    _warn(TAG, 'project quick tool refused: the tool list is not trusted', { root: snapshot.root, tool_id: storeToolId })
    return null
  }
  return tool
}
