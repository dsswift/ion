/**
 * principal-paths — the TypeScript mirror of the engine's FR-01 partition
 * layout (`engine/internal/conversation/partition.go`).
 *
 * The server does not own conversation storage -- the engine does -- but
 * five server modules read `<dataDir>/conversations` directly for reasons
 * that never round-trip through the engine's own RPCs (a synchronous
 * existence probe on the hot restore path, a backup export, an image
 * decode, a telemetry root). Once FR-01 partitioning is enabled, those same
 * five reads must resolve into the ACTING principal's own partition, not
 * the flat root, or they silently see nothing for every attributed session.
 *
 * `principalDir` MUST stay byte-for-byte identical to the Go
 * `PrincipalDir` function -- same sanitize regex, same truncation length,
 * same hash algorithm and slice length, same separator and empty-string
 * fallback -- because the two sides derive the SAME directory name
 * independently; there is no wire RPC carrying it. `principal-paths.test.ts`
 * pins fixed subject/directory pairs computed by both implementations.
 */
import { join } from 'path'
import { dataDir } from '../paths'
import { getEngineHostInfo, peekEngineHostInfo } from '../engine/engine-bridge-fs'
import { principalConversationsDir } from './principal-dir'

// `principalDir`/`principalConversationsDir` are pure (no engine-bridge
// dependency) and live in `principal-dir.ts` so a consumer that only needs
// the hash function -- `git/identity/materialize.ts` -- never pulls in
// `engine-bridge-fs.ts` (and transitively `state.ts`'s `new EngineBridge()`)
// just by importing this file. Re-exported here so every existing
// `from './principal-paths'` import of them keeps working unchanged.
export { principalDir, principalConversationsDir, principalRootDir } from './principal-dir'

/**
 * Resolves the directory to read/write conversation files in for `subject`.
 * Returns the flat `<dataDir>/conversations` root when partitioning is
 * disabled on the connected engine (the historical, single-owner-desktop
 * behavior, unchanged) OR when `subject` is empty (an unattributed caller
 * never sees a partition, matching the engine's own rule) -- so every
 * caller of this function needs no branch of its own for either case.
 */
export async function resolveConversationsDir(subject: string | undefined): Promise<string> {
  const flat = join(dataDir(), 'conversations')
  if (!subject) return flat
  const info = await getEngineHostInfo()
  if (!info.ok || !info.data?.principalPartitioning?.enabled) return flat
  return principalConversationsDir(subject)
}

/**
 * Synchronous counterpart of {@link resolveConversationsDir}, for the
 * handful of call sites that cannot become async without a wider refactor
 * (a hot restore-path existence probe, a DI-injected path object built
 * eagerly). Reads {@link peekEngineHostInfo}'s already-cached value instead
 * of issuing an RPC -- `listener.ts` warms this cache at connection start,
 * so it is populated for the entire life of a normal server process. A cold
 * cache (nothing has ever fetched host info yet) resolves to the flat root,
 * same fail-open rule as the async form.
 */
export function resolveConversationsDirSync(subject: string | undefined): string {
  const flat = join(dataDir(), 'conversations')
  if (!subject) return flat
  const info = peekEngineHostInfo()
  if (!info?.principalPartitioning?.enabled) return flat
  return principalConversationsDir(subject)
}
