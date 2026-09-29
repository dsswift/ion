/**
 * environment/fs-browse — `environment.fs.browse`: the directories under a
 * path on THIS server's host, for the Environment page's folder browser.
 *
 * The server runs on the host whose filesystem the operator is choosing a
 * project folder on, so this reads the local filesystem directly; a remote
 * desktop reaches it through the studio wire. Directories only (a project is
 * a folder), hidden ones on request, each marked when it is a git checkout so
 * the browser can offer "Add as project" on the spot.
 */
import { readdirSync, existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { EnvironmentFsBrowse } from '@ion/shared/types-environment-admin'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.fs-browse'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** `~` and `~/x` resolve against the server user's home; anything else is made absolute. */
export function expandHome(path: string, home: string = homedir()): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return resolve(trimmed)
}

export function browseDirectory(path: string, showHidden: boolean, home: string = homedir()): EnvironmentFsBrowse {
  const target = expandHome(path, home)
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    warn('browse refused: not a directory', { path: target })
    throw new Error(`${target} is not a directory on this host`)
  }
  const parent = dirname(target)
  const entries: EnvironmentFsBrowse['entries'] = []
  for (const dirent of readdirSync(target, { withFileTypes: true })) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    if (!showHidden && dirent.name.startsWith('.')) continue
    const fullPath = join(target, dirent.name)
    let isDir = dirent.isDirectory()
    if (dirent.isSymbolicLink()) {
      try { isDir = statSync(fullPath).isDirectory() } catch { isDir = false } // silent-ok: a dangling symlink is simply not a directory to list
    }
    if (!isDir) continue
    entries.push({ name: dirent.name, fullPath, isGitRepo: existsSync(join(fullPath, '.git')) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  log('browsed', { path: target, entry_count: entries.length, show_hidden: showHidden })
  return { path: target, parentPath: parent === target ? null : parent, pathIsGitRepo: existsSync(join(target, '.git')), home, entries }
}
