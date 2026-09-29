/**
 * chokidar-backed implementation of the subscribe/unsubscribe watch shape
 * (`WatchModule` in `git/watcher.ts` and `graph-view/corpus-watch.ts`).
 *
 * Replaces `@parcel/watcher`, which this server used until 2026-09-16. That
 * native addon has two long-open, unresolved crash bugs in its Linux/inotify
 * backend that this server hit in production:
 *
 * - parcel-bundler/watcher#141: musl libc's `__membarrier` fallback sends an
 *   internal thread-sync signal that interrupts the backend's blocking
 *   `poll()` call; the native code doesn't handle the interruption and
 *   segfaults instead of retrying. Alpine-specific (musl only); still open
 *   and reproducing as of 2026-05.
 * - parcel-bundler/watcher#258 (duplicate of #206, wrongly closed without a
 *   fix): two C++ static caches (`dirTreeCache` / the per-backend map) are
 *   destroyed in an order libc doesn't guarantee, so tearing down a watcher
 *   (unsubscribe, not just process exit) can reach into an already-freed
 *   cache. Reproduces on glibc too — not Alpine-specific — and its stack
 *   trace matches exactly what tearing down THIS server's git watcher
 *   produced: `InotifyBackend::~InotifyBackend()` -> `DirTreeDeleter` ->
 *   freed `dirTreeCache`.
 *
 * chokidar has zero native code (it wraps Node's own built-in `fs.watch`),
 * so neither bug class is reachable here. `chokidar@4` specifically (not the
 * ESM-only `@5`) because it ships a real CJS `require` export, matching this
 * server's `createRequire`-based external-module loading in
 * `scripts/build.mjs`.
 */

import chokidar from 'chokidar'
import picomatch from 'picomatch'

export interface WatchEvent { path: string; type: string }
export interface WatchSubscription { unsubscribe: () => Promise<void> }
export interface WatchOptions { ignore?: string[] }
export interface WatchModule {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: WatchEvent[]) => void,
    opts?: WatchOptions,
  ): Promise<WatchSubscription>
}

/**
 * chokidar 4 dropped glob-string support from its own `ignored` option (the
 * anymatch/is-glob dependency chain chokidar 3 and @parcel/watcher both used
 * for this is gone from v4's rewrite) -- passing a glob string is silently a
 * no-op, confirmed directly against the installed version: `.git` stayed
 * watched and its events kept arriving. `ignored` now only accepts a
 * predicate function, so this builds one with picomatch (the same glob
 * engine @parcel/watcher itself depends on for its own `ignore` option).
 *
 * A bare fragment like `.git` or `node_modules` (what both call sites pass
 * today) needs to match that name anywhere in the tree, as both a leaf and a
 * directory prefix. A fragment that already looks like a glob (contains one
 * of `*?[]`) is assumed intentional and passed through unchanged, so a
 * caller that already writes `**\/.git/**` keeps working too. `dot: true`
 * is required for either case: picomatch does not match a dotfile/dotdir
 * segment like `.git` against `**` by default.
 */
function toIgnorePredicate(fragments: string[] | undefined): ((path: string) => boolean) | undefined {
  if (!fragments || fragments.length === 0) return undefined
  const patterns = fragments.flatMap((fragment) =>
    /[*?[\]]/.test(fragment) ? [fragment] : [`**/${fragment}`, `**/${fragment}/**`],
  )
  const isMatch = picomatch(patterns, { dot: true })
  return (path: string) => isMatch(path)
}

function chokidarEventToType(event: string): string {
  switch (event) {
    case 'add':
    case 'addDir':
      return 'create'
    case 'unlink':
    case 'unlinkDir':
      return 'delete'
    default:
      return 'update'
  }
}

export const chokidarWatchModule: WatchModule = {
  subscribe(dir, cb, opts) {
    return new Promise((resolve, reject) => {
      const watcher = chokidar.watch(dir, {
        ignored: toIgnorePredicate(opts?.ignore),
        ignoreInitial: true,
        persistent: true,
      })

      // subscribe()'s promise settles once, on whichever of ready/error
      // happens first. After that, an error is an ongoing-watch failure
      // delivered through the callback, matching @parcel/watcher's shape.
      let settled = false

      watcher.on('ready', () => {
        if (settled) return
        settled = true
        resolve({
          unsubscribe: () => watcher.close(),
        })
      })

      watcher.on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        if (!settled) {
          settled = true
          reject(error)
          return
        }
        cb(error, [])
      })

      watcher.on('all', (event: string, path: string) => {
        cb(null, [{ path, type: chokidarEventToType(event) }])
      })
    })
  },
}
