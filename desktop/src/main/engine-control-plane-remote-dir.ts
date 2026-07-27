/**
 * Remote working-directory resolution for prompt submission.
 *
 * Extracted from `EngineControlPlane.submitPrompt` to keep that class under
 * the 600-line cap. The behavior is unchanged; this is the same guard the
 * prompt path has always run, in its own module.
 *
 * When the engine is remote, the working directory must exist on the ENGINE
 * host — the desktop's local file dialog cannot know that. If a stale path
 * from this desktop's filesystem is sent, the CLI dies with chdir errors and
 * the tab silently stays idle. So: resolve `~`-prefixed paths against the
 * engine's home, probe the engine, and surface an actionable error instead of
 * a silent stall.
 */
import { engineIsRemote, getEngineHostInfo, listEngineDirectory } from './engine-bridge-fs'
import { log as _log, warn as _warn } from './logger'
import type { EngineConfig } from '../shared/types'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Resolve and verify `config.workingDirectory` against a remote engine host.
 *
 * Mutates `config.workingDirectory` in place when a `~`-prefixed path is
 * expanded against the engine's home (the caller's config object is the one
 * handed to `startSession`, so the resolved value must land on it).
 *
 * Returns `{ ok: true }` for a local engine (no probe needed), an empty
 * working directory (nothing to verify), or a confirmed remote directory.
 * Returns `{ ok: false, message }` when the directory is unreachable on the
 * engine host; the caller surfaces `message` to the user.
 */
export async function resolveRemoteWorkingDirectory(
  tabId: string,
  config: EngineConfig,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!engineIsRemote() || !config.workingDirectory) return { ok: true }

  let wd = config.workingDirectory
  if (wd === '~' || wd.startsWith('~/')) {
    const hostInfo = await getEngineHostInfo()
    if (hostInfo.ok && hostInfo.data?.home) {
      wd = wd === '~' ? hostInfo.data.home : `${hostInfo.data.home}/${wd.slice(2)}`
      config.workingDirectory = wd
    }
  }

  const probe = await listEngineDirectory(wd, false)
  if (!probe.ok) {
    warn('working_directory: unreachable on engine', { tab_id: tabId, dir: wd, error: probe.error })
    return {
      ok: false,
      message:
        `Working directory "${wd}" does not exist on the engine host. ` +
        'Choose a directory on the remote engine via the status-bar folder picker, then try again.',
    }
  }

  log('working_directory: confirmed', { tab_id: tabId, dir: wd })
  return { ok: true }
}
