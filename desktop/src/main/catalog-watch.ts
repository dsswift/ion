/**
 * catalog-watch — tells Studio when the Environment catalog changed on disk.
 *
 * `ion fleet` writes the same catalog Studio reads (`environments` in the
 * device settings file). Studio's own writes go through the renderer, which
 * already knows about them; this notices the ones made by another process,
 * so a server added or removed from a terminal shows up in a running Studio.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { log as _log, warn as _warn } from './logger'

const TAG = 'catalog-watch'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** How long writes are let settle before the file is read: an atomic write is a create and a rename. */
const SETTLE_MS = 150

/** The `environments` value of the settings file as stable text; empty when there is none. */
function catalogText(file: string): string {
  if (!existsSync(file)) return ''
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { environments?: unknown }
    return JSON.stringify(parsed.environments ?? [])
  } catch (err) {
    // A reader can land between another process's truncate and write.
    warn('device settings unreadable while watching the catalog', { file, error: String(err) })
    return ''
  }
}

/**
 * Calls `onChange` whenever the catalog in `file` differs from the last one
 * seen. Returns the function that stops the watch. `note` records a catalog
 * this process just wrote, so its own write is not reported back to it.
 */
export function watchCatalog(file: string, onChange: () => void): { stop(): void; note(): void } {
  let seen = catalogText(file)
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  const check = (): void => {
    timer = null
    const now = catalogText(file)
    if (now === '' || now === seen) return
    seen = now
    log('environment catalog changed on disk', { file })
    onChange()
  }
  try {
    // The directory, not the file: an atomic write replaces the file, which ends a watch on the file itself.
    watcher = watch(dirname(file), (_event, name) => {
      if (name !== null && name !== basename(file)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, SETTLE_MS)
    })
    watcher.on('error', (err) => warn('catalog watch error', { file, error: String(err) }))
    log('watching the environment catalog', { file })
  } catch (err) {
    warn('catalog watch could not start', { file, error: String(err) })
  }
  return {
    stop(): void {
      if (timer) clearTimeout(timer)
      timer = null
      watcher?.close()
      watcher = null
    },
    note(): void { seen = catalogText(file) },
  }
}
