/**
 * Resolve a file path the operator clicked in a transcript, a terminal, or a
 * markdown preview.
 *
 * The path is written the way the agent wrote it: absolute, `~/`-relative, or
 * relative to the conversation's working directory. Only the machine that
 * owns the conversation knows its own home directory and filesystem, so the
 * resolution happens here, on that machine, rather than in the client, which
 * may be a different computer with a different home.
 */
import { statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { isValidProjectPath } from '../ipc-validation'
import { debug as _debug, warn as _warn } from '../logger'
import type { FileLinkTarget } from '@ion/shared/file-link'

const TAG = 'resolve-file-link'

/** Expand `raw` against this machine's home and `cwd`, then stat it. */
export function resolveFileLink(request: unknown): FileLinkTarget {
  const { path: raw, cwd } = (request ?? {}) as { path?: unknown; cwd?: unknown }
  const missing: FileLinkTarget = { path: '', exists: false, isDirectory: false, size: 0 }
  if (typeof raw !== 'string' || raw.length === 0 || /[\0\r\n]/.test(raw)) {
    _warn(TAG, 'rejected file link: invalid path', { path_type: typeof raw })
    return missing
  }
  const home = homedir()
  const base = typeof cwd === 'string' && isValidProjectPath(cwd) ? cwd : home
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? home + raw.slice(1) : raw
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
  try {
    const st = statSync(path)
    const target = { path, exists: true, isDirectory: st.isDirectory(), size: st.isDirectory() ? 0 : st.size }
    _debug(TAG, 'file link resolved', { raw_path: raw, path, is_directory: target.isDirectory, bytes: target.size })
    return target
  } catch (err) {
    _debug(TAG, 'file link target missing', { raw_path: raw, path, error: String(err) })
    return { ...missing, path }
  }
}
