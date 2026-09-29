import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PersistedTab, PersistedTabState } from '@ion/shared/types-persistence'
import type { TransferPaths } from '../paths'

/** A fresh, isolated TransferPaths rooted at a new temp directory. */
export function makeTestPaths(prefix: string): TransferPaths {
  const root = mkdtempSync(join(tmpdir(), `ion-transfer-${prefix}-`))
  const conversationsDir = join(root, 'conversations')
  mkdirSync(conversationsDir, { recursive: true })
  return {
    conversationsDir,
    tabsFile: join(root, 'tabs.json'),
    tabContentDir: join(root, 'tab-content'),
    settingsFile: join(root, 'settings.json'),
    worktreeRegistryFile: join(root, 'worktree-registry.json'),
    dataDir: root,
  }
}

/** Writes a minimal `.llm.jsonl` + `.tree.jsonl` pair for `id`. */
export function writeConversationFixture(
  conversationsDir: string,
  id: string,
  opts: { parentId?: string; forkOf?: string; nativeSessions?: Record<string, unknown> } = {},
): void {
  const llmHeader: Record<string, unknown> = {
    meta: true,
    id,
    version: 2,
    model: 'test-model',
    system: '',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    createdAt: Date.now(),
  }
  if (opts.parentId) llmHeader.parentId = opts.parentId
  if (opts.forkOf) llmHeader.forkOf = opts.forkOf
  writeFileSync(join(conversationsDir, `${id}.llm.jsonl`), `${JSON.stringify(llmHeader)}\n`)

  const treeHeader: Record<string, unknown> = {
    meta: true,
    id,
    version: 2,
    leafId: null,
    workingDirectory: '/tmp/example',
  }
  if (opts.nativeSessions) treeHeader.nativeSessions = opts.nativeSessions
  writeFileSync(join(conversationsDir, `${id}.tree.jsonl`), `${JSON.stringify(treeHeader)}\n{"id":"e1","parentId":null,"type":"message","timestamp":1,"data":{}}\n`)
}

export function minimalPersistedTab(overrides: Partial<PersistedTab> & { id: string; conversationId: string }): PersistedTab {
  return {
    title: 'Test tab',
    customTitle: null,
    workingDirectory: '/tmp/example',
    hasChosenDirectory: false,
    additionalDirs: [],
    ...overrides,
  }
}

export function writeTabsFile(tabsFile: string, tabs: PersistedTab[]): void {
  const state: PersistedTabState = { activeSessionId: null, tabs }
  writeFileSync(tabsFile, JSON.stringify(state, null, 2))
}
