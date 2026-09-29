/**
 * transfer/paths — the on-disk locations transfer.ts's export/import
 * functions read and write, injected rather than reached for globally.
 *
 * `settingsDir()` (settings.json, tabs.json) and the conversations directory
 * both derive from `dataDir()` (`../paths.ts`), resolved fresh on every call.
 * The existing test convention for isolating them is still
 * `vi.mock('.../persistence/settings-store', ...)`, not a per-test
 * `ION_DATA_DIR` override. This module's `TransferPaths` follows that same DI
 * convention so every transfer function can be exercised against real temp
 * directories in a test without touching the operator's actual `~/.ion`.
 */
import { join } from 'path'
import { dataDir } from '../paths'
import { tabsFile, settingsFile } from '../persistence/settings-store'
import { tabContentDir } from '../persistence/tab-content-store'
import { worktreeRegistryFile } from '../worktree/registry'
import { resolveConversationsDirSync } from '../conversation/principal-paths'

export interface TransferPaths {
  conversationsDir: string
  tabsFile: string
  tabContentDir: string
  settingsFile: string
  worktreeRegistryFile: string
  /** `dataDir()/transfer-inbox` and `dataDir()/transfer-outbox` live under this. */
  dataDir: string
}

/**
 * The real, production paths. `subject`, when supplied, is the acting
 * principal a transfer export/import is scoped to (FR-01): once
 * partitioning is enabled, an export must read the tab it's exporting from
 * that principal's OWN partition, never the flat root or another
 * principal's. Omitted (or unresolvable) falls back to the flat root,
 * unchanged from before partitioning existed.
 */
export function defaultTransferPaths(subject?: string): TransferPaths {
  return {
    conversationsDir: resolveConversationsDirSync(subject),
    tabsFile: tabsFile(),
    tabContentDir: tabContentDir(),
    settingsFile: settingsFile(),
    worktreeRegistryFile: worktreeRegistryFile(),
    dataDir: dataDir(),
  }
}

export function transferOutboxDir(paths: TransferPaths): string {
  return join(paths.dataDir, 'transfer-outbox')
}

export function transferInboxDir(paths: TransferPaths): string {
  return join(paths.dataDir, 'transfer-inbox')
}
