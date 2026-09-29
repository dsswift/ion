/**
 * Which conversations a transfer takes.
 *
 * A tab owns its current conversation, the history a checkpoint cut left
 * behind, and their dispatch children. A fork of it is a different
 * conversation, often with its own tab, and a transfer must neither carry
 * it away nor delete its files. Before the family was scoped this way, a
 * fork followed its source through `parentId` and was deleted from the
 * source machine with it, and a tab's earlier history was left behind.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import type { PersistedTabState } from '@ion/shared/types-persistence'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { removeTransferredSource } from '../remove-source'
import { collectFamily, conversationsOwnedByOtherTabs } from '../collect-family'
import { _resetParentIndexForTest } from '../parent-index'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab } from './fixtures'
import type { TransferPaths } from '../paths'

afterEach(() => _resetParentIndexForTest())

function landingDir(paths: TransferPaths): string {
  const dir = join(paths.dataDir, 'projects', 'ion')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * tab-1: history `old-1` cut to current `cur-1`, which has a dispatch child.
 * `fork-1` is a marked fork of `cur-1` open in tab-2; `legacy-fork` is an
 * unmarked fork of `cur-1` settled on tab-3.
 */
function seed(paths: TransferPaths): void {
  writeConversationFixture(paths.conversationsDir, 'old-1')
  writeConversationFixture(paths.conversationsDir, 'cur-1', { parentId: 'old-1' })
  writeConversationFixture(paths.conversationsDir, 'child-1', { parentId: 'cur-1' })
  writeConversationFixture(paths.conversationsDir, 'fork-1', { parentId: 'cur-1', forkOf: 'cur-1' })
  writeConversationFixture(paths.conversationsDir, 'fork-child', { parentId: 'fork-1' })
  writeConversationFixture(paths.conversationsDir, 'legacy-fork', { parentId: 'cur-1' })
  const state: PersistedTabState = {
    activeSessionId: null,
    tabs: [
      minimalPersistedTab({ id: 'tab-1', conversationId: 'cur-1', historicalSessionIds: ['old-1'] }),
      minimalPersistedTab({ id: 'tab-2', conversationId: 'fork-1' }),
    ],
    settledHistory: [minimalPersistedTab({ id: 'tab-3', conversationId: 'legacy-fork' })],
  }
  writeFileSync(paths.tabsFile, JSON.stringify(state))
}

describe('transfer family', () => {
  it('takes the tab\'s history and dispatch children, never a fork', async () => {
    const paths = makeTestPaths('family-scope')
    seed(paths)
    const state = readTabsState(paths.tabsFile)
    const family = await collectFamily('cur-1', paths.conversationsDir, {
      tab: state.tabs[0],
      ownedElsewhere: conversationsOwnedByOtherTabs(state, 'tab-1'),
    })
    expect(family.ids.sort()).toEqual(['child-1', 'cur-1', 'old-1'])
  })

  it('leaves a fork\'s files on the source, and moves the history', async () => {
    const source = makeTestPaths('family-source')
    const target = makeTestPaths('family-target')
    seed(source)

    const exported = await runTransferExport({
      tab: { id: 'tab-1', status: 'idle', worktree: null },
      tabRecord: readTabsState(source.tabsFile).tabs[0],
      tabContent: null,
      targetEnvironmentId: 'env-target',
      sourceEnvironmentId: 'env-source',
      paths: source,
      destinationPath: join(source.dataDir, 'export.zip'),
      isWorktreeDirty: async () => false,
      buildWorktreeBundle: async () => null,
      persistSealPending: (sealPending) => persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', sealPending),
    })
    if (!exported.ok) throw new Error(exported.refusal.code)
    expect(exported.manifest.conversationIds.sort()).toEqual(['child-1', 'cur-1', 'old-1'])

    const imported = await runTransferImport({ archivePath: exported.archivePath, paths: target, callerSubject: 'importer@example.com', landing: { kind: 'checkout', dir: landingDir(target) }, checkoutWorktreeFromBundle: async () => null })
    expect(imported.ok).toBe(true)
    expect(existsSync(join(target.conversationsDir, 'old-1.llm.jsonl'))).toBe(true)
    expect(existsSync(join(target.conversationsDir, 'fork-1.llm.jsonl'))).toBe(false)

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source })
    expect(removal.ok).toBe(true)
    for (const id of ['cur-1', 'old-1', 'child-1']) {
      expect(existsSync(join(source.conversationsDir, `${id}.llm.jsonl`))).toBe(false)
    }
    for (const id of ['fork-1', 'fork-child', 'legacy-fork']) {
      expect(existsSync(join(source.conversationsDir, `${id}.llm.jsonl`))).toBe(true)
    }
  })
})
