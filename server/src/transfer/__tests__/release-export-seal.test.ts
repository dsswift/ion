/**
 * The "moving" mark an export sets comes off when that export's archive
 * never reaches the destination: on the server when building it fails, and
 * through `transfer.release` when the client's download fails. The release
 * only ever undoes the mark its own export set.
 */
import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { releaseExportSeal } from '../pending'
import { readTab, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'

describe('releaseExportSeal', () => {
  it('clears only the mark whose since matches', () => {
    const paths = makeTestPaths('release')
    writeTabsFile(paths.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'c1' })])
    persistSealPendingOnTabsFile(paths.tabsFile, 'tab-1', { targetEnvironmentId: 'env-b', since: 2000 })

    expect(releaseExportSeal({ tabId: 'tab-1', sealedAt: 1000, paths })).toEqual({ ok: true, released: false })
    expect(readTab(paths.tabsFile, 'tab-1')?.sealPending?.since).toBe(2000)

    expect(releaseExportSeal({ tabId: 'tab-1', sealedAt: 2000, paths })).toEqual({ ok: true, released: true })
    expect(readTab(paths.tabsFile, 'tab-1')?.sealPending).toBeUndefined()
  })
})

describe('runTransferExport', () => {
  it('releases its own mark when the export fails after setting it', async () => {
    const paths = makeTestPaths('release-export')
    writeConversationFixture(paths.conversationsDir, 'root-1')
    const record = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })
    writeTabsFile(paths.tabsFile, [record])
    writeFileSync(paths.settingsFile, JSON.stringify({ projects: { '/repo/source': { repoRemote: 'github.com/org/repo' } } }))
    const released: number[] = []
    const result = await runTransferExport({
      tab: { id: 'tab-1', status: 'idle', worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' } },
      tabRecord: record,
      tabContent: null,
      targetEnvironmentId: 'env-b',
      sourceEnvironmentId: 'env-a',
      paths,
      destinationPath: join(paths.dataDir, 'export.zip'),
      isWorktreeDirty: async () => false,
      buildWorktreeBundle: async () => { throw new Error('bundle failed') },
      carryWorktree: true,
      now: () => 4242,
      persistSealPending: (seal) => persistSealPendingOnTabsFile(paths.tabsFile, 'tab-1', seal),
      releaseSealPending: (seal) => { released.push(seal.since); releaseExportSeal({ tabId: 'tab-1', sealedAt: seal.since, paths }) },
    }).catch((err: unknown) => ({ ok: false as const, thrown: String(err) }))
    expect(result.ok).toBe(false)
    expect(released).toEqual([4242])
    expect(readTab(paths.tabsFile, 'tab-1')?.sealPending).toBeUndefined()
  })
})
