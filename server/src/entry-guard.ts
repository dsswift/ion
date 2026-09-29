/**
 * entry-guard -- "is this module the process entry point?"
 *
 * `main.ts` and `cli/pair.ts` auto-run only when invoked directly (`node
 * dist/main.js`), not when a test imports them. Comparing
 * `fileURLToPath(import.meta.url)` to `process.argv[1]` byte-for-byte is
 * wrong for any invocation through a symlink: Node resolves the ESM URL to
 * the REAL path while argv[1] keeps the path as typed. The installed Studio
 * server runs every entry through `~/.ion/studio-server/current/...` (a
 * symlink the updater repoints), and macOS's `/var` is itself a symlink to
 * `/private/var`, so the naive comparison silently skipped `main()` on the
 * host: the service "started", printed nothing, and exited 0.
 */
import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'

/** True when `moduleUrl`'s file is what `node` was asked to run, resolving symlinks on both sides. */
export function isProcessEntry(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false
  const self = safeRealpath(fileURLToPath(moduleUrl))
  return self === safeRealpath(argv1)
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // silent-ok: a path that cannot be resolved compares as itself, which can only make the guard stricter
    return path
  }
}
