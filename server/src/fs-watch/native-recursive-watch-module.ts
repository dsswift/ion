/**
 * `WatchModule` on Node's own recursive `fs.watch`, one watch per root.
 *
 * ── Why not chokidar for the tree ────────────────────────────────────────────
 *
 * chokidar 4 (`chokidar-watch-module.ts`) has no FSEvents backend: on macOS it
 * puts a non-recursive `fs.watch` -- a kqueue descriptor -- on every
 * directory AND every file under the root. The git working-tree watcher
 * subscribes to a whole checkout with only `.git`/`node_modules` excluded, so
 * a checkout that carries a packaged `desktop/release/*.app` sat at ~8,000
 * open descriptors while idle. Every spawn after that failed with EBADF: the
 * worktree inventory could not list worktrees, the bench snapshot could not
 * read a member's contribution, and the Inbox drew "worktree gone" and "no
 * commits yet" for checkouts that were fine.
 *
 * `fs.watch(root, { recursive: true })` is FSEvents on macOS and
 * ReadDirectoryChangesW on Windows: one descriptor per root regardless of
 * tree size. On Linux Node implements it over inotify (watch descriptors, not
 * file descriptors; libuv's own per-directory scheme). Where the platform
 * refuses recursion, `subscribe` falls back to the chokidar module rather
 * than watching nothing.
 *
 * Event mapping matches the chokidar adapter: `rename` becomes `create` or
 * `delete` by whether the path exists afterwards, `change` is `update`.
 * Ignore fragments use the same picomatch translation.
 */
import { watch, existsSync, type FSWatcher } from 'fs'
import { join, sep } from 'path'
import picomatch from 'picomatch'
import { chokidarWatchModule, type WatchEvent, type WatchModule, type WatchOptions } from './chokidar-watch-module'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fs-watch', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fs-watch', msg, fields)
}

/** Same fragment grammar as the chokidar adapter, matched against the path RELATIVE to the root. */
export function toIgnorePredicate(fragments: string[] | undefined): ((relativePath: string) => boolean) | undefined {
  if (!fragments || fragments.length === 0) return undefined
  const patterns = fragments.flatMap((fragment) =>
    /[*?[\]]/.test(fragment) ? [fragment] : [`**/${fragment}`, `**/${fragment}/**`, fragment, `${fragment}/**`],
  )
  const isMatch = picomatch(patterns, { dot: true })
  return (relativePath: string) => isMatch(relativePath.split(sep).join('/'))
}

/** Injectable for tests: which platforms are asked for a recursive native watch. */
export function recursiveWatchSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
}

export interface NativeWatchDeps {
  watchFn?: typeof watch
  platform?: NodeJS.Platform
  fallback?: WatchModule
}

export function createNativeRecursiveWatchModule(deps: NativeWatchDeps = {}): WatchModule {
  const watchFn = deps.watchFn ?? watch
  const fallback = deps.fallback ?? chokidarWatchModule
  return {
    subscribe(dir: string, cb: (err: Error | null, events: WatchEvent[]) => void, opts?: WatchOptions) {
      if (!recursiveWatchSupported(deps.platform)) {
        log('recursive fs.watch not supported on this platform; using chokidar', { dir, platform: deps.platform ?? process.platform })
        return fallback.subscribe(dir, cb, opts)
      }
      const ignored = toIgnorePredicate(opts?.ignore)
      let watcher: FSWatcher
      try {
        watcher = watchFn(dir, { recursive: true, persistent: true }, (eventType, filename) => {
          if (filename === null || filename === undefined) return
          const relative = String(filename)
          if (ignored?.(relative)) return
          const path = join(dir, relative)
          const type = eventType === 'change' ? 'update' : (existsSync(path) ? 'create' : 'delete')
          cb(null, [{ path, type }])
        })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
          warn('recursive fs.watch unavailable; using chokidar', { dir, error: String(err) })
          return fallback.subscribe(dir, cb, opts)
        }
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
      watcher.on('error', (err: Error) => cb(err, []))
      log('recursive watch started', { dir, ignore_count: opts?.ignore?.length ?? 0 })
      return Promise.resolve({
        unsubscribe: () => {
          watcher.close()
          log('recursive watch stopped', { dir })
          return Promise.resolve()
        },
      })
    },
  }
}

/** The module every caller should use: one native recursive watch per root, chokidar only where the platform cannot recurse. */
export const defaultWatchModule: WatchModule = createNativeRecursiveWatchModule()
