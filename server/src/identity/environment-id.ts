/**
 * The server's own stable identity: `environmentId` on the Studio wire
 * (manifest contract C3 `studio_welcome.environmentId`) and `serverId` in
 * `main.ts`'s boot log — the same value under two names for two audiences.
 * One server process is one Studio "environment" (per the Ion Studio Server
 * program's framing: a client connects to a headless server as one of many
 * Environments), so this id is the thing a reverse `studio_command`
 * (`protocol/commands.ts`) is ultimately addressed at, even though today's
 * single-environment-per-process reality means routing never has to choose
 * between two.
 *
 * Extracted from `main.ts` (which minted and cached this privately) so
 * `protocol/hello.ts` and `protocol/commands.ts` can read the same value
 * without depending on `main.ts` or re-minting a second id.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('environment-id', msg, fields)
}

let cached: string | null = null

/** Reads `dir/server-id`, minting a UUID v4 and persisting it when absent or empty. Caches the result. */
export function loadOrMintEnvironmentId(dir: string): { id: string; source: 'existing' | 'minted' } {
  const path = join(dir, 'server-id')
  if (existsSync(path)) {
    const id = readFileSync(path, 'utf-8').trim()
    if (id) {
      cached = id
      return { id, source: 'existing' }
    }
    warn('server-id file present but empty; minting a fresh one', { path })
  }
  const id = crypto.randomUUID()
  atomicWriteFileSync(path, id + '\n', 0o644)
  cached = id
  return { id, source: 'minted' }
}

/** Synchronous accessor. Null until `loadOrMintEnvironmentId` has run once this process. */
export function currentEnvironmentId(): string | null {
  return cached
}

/**
 * Read-only peek at `dir/server-id`, never minting or writing. Used by boot
 * code that needs a stable identifier BEFORE the boot-order point where
 * minting is allowed to happen (`main.ts` only mints after the state-files
 * corruption gate, so a corrupt `tabs.json` never gets a `server-id` file --
 * see `__tests__/boot.test.ts`'s "server-id was minted" assertion). Returns
 * null when the file is absent or empty; callers needing an id at that
 * early point (the win32 named-pipe path) fall back to a per-boot value.
 */
export function peekEnvironmentId(dir: string): string | null {
  try {
    const path = join(dir, 'server-id')
    if (!existsSync(path)) return null
    const id = readFileSync(path, 'utf-8').trim()
    return id || null
  } catch (err) {
    warn('server-id peek failed', { error: String(err) })
    return null
  }
}

/** TEST ONLY. */
export function _setEnvironmentIdForTest(id: string | null): void {
  cached = id
}
