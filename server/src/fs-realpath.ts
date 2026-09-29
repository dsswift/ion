/**
 * Windows-safe `realpathSync`.
 *
 * `fs.realpathSync` is a pure-JS implementation that walks each path
 * component and follows symlinks; it does not resolve a Windows short (8.3)
 * name — `C:\Users\RUNNER~1\...` — to the long form the OS (and git's own
 * path resolution) reports for the same directory. `fs.realpathSync.native`
 * calls the OS directly and resolves both symlinks and 8.3 names, which is
 * what every containment check here needs: comparing a canonicalized path
 * against a workspace record's stored path only works when both sides agree
 * on which spelling of the directory they mean.
 *
 * `.native` carries a documented caveat on some Unix filesystems (a stale
 * `getattrlist` cache can return an outdated symlink target), so it is used
 * only on win32, where the short-name problem actually occurs; macOS and
 * Linux keep the plain implementation they already use everywhere else.
 */
import { realpathSync as fsRealpathSync } from 'fs'

export function realpathSyncPortable(p: string): string {
  return process.platform === 'win32' ? fsRealpathSync.native(p) : fsRealpathSync(p)
}
