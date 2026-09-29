/**
 * `principalDir` — the pure half of `principal-paths.ts`, split into its own
 * leaf module with NO dependency on the engine bridge.
 *
 * `principal-paths.ts`'s `resolveConversationsDir`/`resolveConversationsDirSync`
 * need `engine-bridge-fs.ts` (to check whether partitioning is enabled on the
 * connected engine), which transitively imports `state.ts`, which constructs
 * `new EngineBridge()` at module load. A consumer that only needs the pure
 * hash function -- `git/identity/materialize.ts`, which materializes a
 * credential under a principal's own directory and has nothing to do with
 * conversation storage -- would otherwise drag that whole chain in too,
 * which is how a circular import through `engine-bridge.ts`'s own module
 * family (`engine-bridge-start-session.ts` importing this transitively)
 * surfaced as `EngineBridge is not a constructor` in engine-bridge test
 * suites that never touch git identity at all.
 *
 * `principalDir` MUST stay byte-for-byte identical to the Go
 * `PrincipalDir` function -- same sanitize regex, same truncation length,
 * same hash algorithm and slice length, same separator and empty-string
 * fallback -- because the two sides derive the SAME directory name
 * independently; there is no wire RPC carrying it. `principal-paths.test.ts`
 * pins fixed subject/directory pairs computed by both implementations.
 */
import { createHash } from 'crypto'
import { join } from 'path'
import { dataDir } from '../paths'

const PRINCIPAL_DIR_SUBJECT_MAX_LEN = 40
const SANITIZE_RUN = /[^a-zA-Z0-9_.-]+/g

/** Mirrors engine `conversation.PrincipalDir(subject string) string`. */
export function principalDir(subject: string): string {
  let sanitized = subject.replace(SANITIZE_RUN, '-').replace(/^-+|-+$/g, '')
  if (sanitized.length > PRINCIPAL_DIR_SUBJECT_MAX_LEN) sanitized = sanitized.slice(0, PRINCIPAL_DIR_SUBJECT_MAX_LEN)
  if (sanitized === '') sanitized = 'principal'
  const hash = createHash('sha256').update(subject, 'utf-8').digest('hex').slice(0, 16)
  return `${sanitized}--${hash}`
}

/** `<dataDir>/principals/<principalDir(subject)>` -- the root a principal's own per-feature subdirectories (conversations, git) live under. */
export function principalRootDir(subject: string): string {
  return join(dataDir(), 'principals', principalDir(subject))
}

/** `<dataDir>/principals/<principalDir(subject)>/conversations` -- mirrors engine `conversation.PartitionConversationsDir`. */
export function principalConversationsDir(subject: string): string {
  return join(principalRootDir(subject), 'conversations')
}
