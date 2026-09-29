import { homedir } from 'os'
import { join } from 'path'

/**
 * Root data directory for this server instance.
 *
 * Mirrors the engine's `utils.IonDir()` (`engine/internal/utils/iondir.go`):
 * when `ION_DATA_DIR` is set in the environment it is returned verbatim (no
 * expansion, no join) so a container, a second server on one machine, or a
 * test harness can each claim an independent data root without colliding on
 * `~/.ion`. When unset, the conventional `<home>/.ion` path is returned.
 *
 * Every path the server owns under its data root -- `server.jsonl`,
 * `server-id`, `tabs.json`, `studio-terminals.json`, `credentials.json`,
 * `integration-workspaces.json`, `worktree-registry.json`, the secret-store
 * keyfile -- derives from this single resolver. A new call site must go
 * through `dataDir()`, never re-join `homedir()` and `'.ion'` directly.
 */
export function dataDir(): string {
  const envDir = process.env.ION_DATA_DIR
  if (envDir) return envDir
  return join(homedir(), '.ion')
}

/** Which branch `dataDir()` took: `'env'` when `ION_DATA_DIR` is set, `'home'` otherwise. */
export function dataDirSource(): 'env' | 'home' {
  return process.env.ION_DATA_DIR ? 'env' : 'home'
}
