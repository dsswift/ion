import { describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'

/**
 * A worktree an import checks out fresh from the bundle has none of its
 * gitignored build state, so the import names it for provisioning. A
 * checkout the import reused (every conversation of a whole-worktree move
 * after the first) was already named by the first, and is not named again.
 */
async function importWith(reused: boolean) {
  const source = makeTestPaths('rw-source')
  const target = makeTestPaths('rw-target')
  try {
    writeConversationFixture(source.conversationsDir, 'root-1')
    const sourceTab = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })
    writeTabsFile(source.tabsFile, [sourceTab])
    writeFileSync(source.settingsFile, JSON.stringify({ projects: { '/repo/source': { repoRemote: 'github.com/org/repo' } } }))
    writeFileSync(target.settingsFile, JSON.stringify({ projects: { '/repo/target': { repoRemote: 'github.com/org/repo' } } }))
    const bundlePath = join(source.dataDir, 'fake.bundle')
    writeFileSync(bundlePath, Buffer.from('bundle bytes'))
    const exported = await runTransferExport({
      tab: { id: 'tab-1', status: 'idle', worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' } },
      tabRecord: sourceTab,
      tabContent: null,
      targetEnvironmentId: 'env-target',
      sourceEnvironmentId: 'env-source',
      paths: source,
      destinationPath: join(source.dataDir, 'export.zip'),
      isWorktreeDirty: async () => false,
      buildWorktreeBundle: async () => ({ bundlePath }),
      carryWorktree: true,
      persistSealPending: (sealPending) => persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', sealPending),
    })
    if (!exported.ok) throw new Error('export failed')
    return await runTransferImport({
      archivePath: exported.archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      checkoutWorktreeFromBundle: async () => ({ worktreePath: '/wt/target', reused }),
    })
  } finally {
    rmSync(source.dataDir, { recursive: true, force: true })
    rmSync(target.dataDir, { recursive: true, force: true })
  }
}

describe('import names a restored worktree for provisioning', () => {
  it('names a checkout made fresh from the bundle', async () => {
    const result = await importWith(false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.restoredWorktree).toEqual({ repoPath: '/repo/target', worktreePath: '/wt/target' })
  })

  it('does not name a checkout it reused', async () => {
    const result = await importWith(true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.worktreePath).toBe('/wt/target')
    expect(result.restoredWorktree).toBeUndefined()
  })
})
