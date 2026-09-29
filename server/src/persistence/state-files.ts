import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../paths'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('state-files', msg, fields)
}

/**
 * The state files the server refuses to boot the store/engine listener
 * against when corrupt (manifest requirement, spec 06 §Functional
 * "Corrupt state file at start"). Filenames only -- resolved against
 * `dataDir()` here, never against `homedir()` directly, so a test or
 * container with `ION_DATA_DIR` set is gated the same way production is.
 */
export const STATE_FILE_NAMES = [
  'tabs.json',
  'settings.json',
  'studio-terminals.json',
  'credentials.json',
  'integration-workspaces.json',
  'worktree-registry.json',
] as const

export type StateFileName = (typeof STATE_FILE_NAMES)[number]

/** Raised when an existing state file's bytes do not parse as JSON. */
export class StateFileCorrupt extends Error {
  constructor(readonly filename: StateFileName, readonly parseError: Error) {
    super(`state file corrupt: ${filename}: ${parseError.message}`)
    this.name = 'StateFileCorrupt'
  }
}

/**
 * Per-file result of the load-or-refuse gate: `present` distinguishes "file
 * absent, defaults apply" (fine) from "file present and parsed" (also fine)
 * -- both are gate passes. A file that exists and fails `JSON.parse` throws
 * {@link StateFileCorrupt} instead of appearing here.
 */
export interface StateFileResult {
  present: boolean
  data: unknown
}

export type StateFiles = Record<StateFileName, StateFileResult>

/**
 * Load-or-refuse gate for the server's flat-file state (manifest C-series;
 * spec 06 §Functional). Reads and `JSON.parse`s each of {@link STATE_FILE_NAMES}
 * under `dataDir()`. A MISSING file is fine -- callers get `present: false`
 * and treat it as an empty/default shape, since a fresh `ION_DATA_DIR` has
 * none of these files yet. A file that EXISTS and fails to parse throws
 * {@link StateFileCorrupt} naming the file, on the FIRST corrupt file found
 * (deterministic order per {@link STATE_FILE_NAMES}) -- the caller (`main.ts`)
 * catches this to flip readiness to `state_file_corrupt` and start only the
 * health listener, never the store/engine wiring, against a data root one of
 * whose files cannot even be read.
 *
 * This function does not validate each file's own schema -- that is the
 * concern of the module that owns the file (`settings-store.ts` for
 * `settings.json`/`tabs.json`, `studio-terminal-persistence.ts` for
 * `studio-terminals.json`, `worktree/registry.ts` for
 * `worktree-registry.json`, `integration/bench-store.ts` for
 * `integration-workspaces.json`). This gate answers exactly one question --
 * "does this file parse as JSON at all" -- because a truncated or
 * half-written file (a crash mid-write, a disk-full `atomicWriteFileSync`
 * rename that lost its temp file) must stop the server from booting a store
 * on top of it rather than silently treating it as empty.
 */
export function loadStateFiles(dir: string = dataDir()): StateFiles {
  const result = {} as StateFiles
  for (const filename of STATE_FILE_NAMES) {
    const path = join(dir, filename)
    if (!existsSync(path)) {
      log('state file absent; defaults apply', { filename })
      result[filename] = { present: false, data: undefined }
      continue
    }
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (err) {
      // A file that exists but cannot even be read (permissions, a race with
      // a concurrent delete) is exactly as unusable as one that fails to
      // parse -- refuse the same way rather than silently defaulting.
      const readErr = err instanceof Error ? err : new Error(String(err))
      log('state file unreadable; refusing to boot', { filename, error: readErr.message })
      throw new StateFileCorrupt(filename, readErr)
    }
    try {
      const data = JSON.parse(raw)
      log('state file loaded', { filename })
      result[filename] = { present: true, data }
    } catch (err) {
      const parseErr = err instanceof Error ? err : new Error(String(err))
      log('state file corrupt; refusing to boot', { filename, error: parseErr.message })
      throw new StateFileCorrupt(filename, parseErr)
    }
  }
  return result
}
