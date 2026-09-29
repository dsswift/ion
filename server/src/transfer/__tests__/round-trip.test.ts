import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { removeTransferredSource } from '../remove-source'
import { promptRefusal } from '@ion/shared/prompt-acceptance'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'

/**
 * Exercises `runTransferExport` and `runTransferImport` directly against two
 * separate temp directories (per spec 10's acceptance criteria — the round
 * trip runs through real archive bytes, not mocks). `settings-store.ts`'s
 * `SETTINGS_DIR`/`TABS_FILE` and the conversations dir are fixed to the real
 * `homedir()` and do not honor `ION_DATA_DIR`; `TransferPaths` dependency
 * injection is how every transfer function is exercised without touching
 * the operator's actual `~/.ion` (see `paths.ts`'s module doc).
 */
describe('transfer export -> import round trip', () => {
  it('carries the conversation family, tab record, tab content, and worktree to a second environment', async () => {
    const source = makeTestPaths('rt-source')
    const target = makeTestPaths('rt-target')
    try {
      writeConversationFixture(source.conversationsDir, 'root-1')
      writeConversationFixture(source.conversationsDir, 'child-1', { parentId: 'root-1', nativeSessions: { 'claude-code': { cursor: 'stale' } } })
      mkdirSync(join(source.conversationsDir, 'root-1', 'images'), { recursive: true })
      writeFileSync(join(source.conversationsDir, 'root-1', 'images', 'a.png'), Buffer.from([1, 2, 3]))

      const sourceTab = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })
      writeTabsFile(source.tabsFile, [sourceTab])

      // Repo identity: pre-seeded on both sides so the round trip does not
      // need a real git checkout to resolve `repoRemote`.
      writeFileSync(source.settingsFile, JSON.stringify({ projects: { '/repo/source': { repoRemote: 'github.com/org/repo' } } }))
      const targetRepoPath = '/repo/target'
      writeFileSync(target.settingsFile, JSON.stringify({ projects: { [targetRepoPath]: { repoRemote: 'github.com/org/repo' } } }))

      const fakeBundlePath = join(source.dataDir, 'fake.bundle')
      writeFileSync(fakeBundlePath, Buffer.from('not a real git bundle, just archive payload'))

      const destinationPath = join(source.dataDir, 'export.zip')
      const tabContent = { tabId: 'tab-1', instanceId: 'main', schemaVersion: 4, messages: [{ role: 'harness', content: 'hello', timestamp: 1 }] }

      const exportResult = await runTransferExport({
        tab: {
          id: 'tab-1',
          status: 'idle',
          worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' },
        },
        tabRecord: sourceTab,
        tabContent,
        targetEnvironmentId: 'env-target',
        sourceEnvironmentId: 'env-source',
        paths: source,
        destinationPath,
        isWorktreeDirty: async () => false,
        buildWorktreeBundle: async () => ({ bundlePath: fakeBundlePath }),
        carryWorktree: true,
    persistSealPending: (sealPending) => persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', sealPending),
      })

      expect(exportResult.ok).toBe(true)
      if (!exportResult.ok) return
      expect(exportResult.totalBytes).toBeGreaterThan(0)
      expect(existsSync(exportResult.archivePath)).toBe(true)
      expect(exportResult.manifest.conversationIds.sort()).toEqual(['child-1', 'root-1'])
      // The native-session cache must not survive export (it is meaningless
      // on the target environment).
      const treeContent = readFileSync(join(source.conversationsDir, 'child-1.tree.jsonl'), 'utf-8')
      expect(treeContent).toContain('nativeSessions')

      // Source tab is sealPending after export, before import ever runs.
      const sourceStateAfterExport = readTabsState(source.tabsFile)
      expect(sourceStateAfterExport.tabs[0].sealPending?.targetEnvironmentId).toBe('env-target')
      expect(promptRefusal({ tab: sourceStateAfterExport.tabs[0] })?.reason).toBe('transfer-pending')

      let checkoutCalls = 0
      const importResult = await runTransferImport({
        archivePath: exportResult.archivePath,
        paths: target,
        callerSubject: 'importer@example.com',
        checkoutWorktreeFromBundle: async (args) => {
          checkoutCalls++
          expect(args.repoPath).toBe(targetRepoPath)
          expect(args.branch).toBe('wt/x')
          expect(args.sourceBranch).toBe('main')
          return { worktreePath: '/wt/target' }
        },
      })

      expect(importResult.ok).toBe(true)
      if (!importResult.ok) return
      expect(checkoutCalls).toBe(1)
      expect(importResult.rootConversationId).toBe('root-1')
      expect(importResult.worktreePath).toBe('/wt/target')
      // A fresh checkout has no gitignored build state; the import names it
      // so the caller provisions it.
      expect(importResult.restoredWorktree).toEqual({ repoPath: targetRepoPath, worktreePath: '/wt/target' })

      // Every family file landed.
      for (const id of ['root-1', 'child-1']) {
        expect(existsSync(join(target.conversationsDir, `${id}.llm.jsonl`))).toBe(true)
        expect(existsSync(join(target.conversationsDir, `${id}.tree.jsonl`))).toBe(true)
      }
      expect(existsSync(join(target.conversationsDir, 'root-1', 'images', 'a.png'))).toBe(true)

      // Tab record carries the IMPORTER's subject, not the exporter's.
      const targetTabsState = readTabsState(target.tabsFile)
      expect(targetTabsState.tabs).toHaveLength(1)
      expect(targetTabsState.tabs[0].principalSubject).toBe('importer@example.com')
      expect(targetTabsState.tabs[0].worktree?.worktreePath).toBe('/wt/target')
      expect(targetTabsState.tabs[0].worktree?.repoPath).toBe(targetRepoPath)
      expect(targetTabsState.tabs[0].sealPending).toBeUndefined()

      // Tab content landed.
      const contentPath = join(target.tabContentDir, `${importResult.tabId}.json`)
      expect(existsSync(contentPath)).toBe(true)
      expect(JSON.parse(readFileSync(contentPath, 'utf-8')).messages).toHaveLength(1)

      // The source is removed, not marked: the conversation now lives on
      // the target and nowhere else.
      const removal = await removeTransferredSource({
        tabId: 'tab-1',
        targetEnvironmentId: 'env-target',
        paths: source,
        retireWorktree: true,
        retireWorktreeFn: async () => ({ ok: true }),
      })
      expect(removal.ok).toBe(true)
      expect(readTabsState(source.tabsFile).tabs).toHaveLength(0)
      expect(existsSync(join(source.conversationsDir, 'root-1.llm.jsonl'))).toBe(false)
    } finally {
      rmSync(source.dataDir, { recursive: true, force: true })
      rmSync(target.dataDir, { recursive: true, force: true })
    }
  })
})
