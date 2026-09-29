import { describe, expect, it } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'

describe('runTransferExport refusals', () => {
  it('refuses when the tab is running', async () => {
    const paths = makeTestPaths('export-running')
    try {
      writeConversationFixture(paths.conversationsDir, 'root-1')
      const tabRecord = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })
      writeTabsFile(paths.tabsFile, [tabRecord])

      const result = await runTransferExport({
        tab: { id: 'tab-1', status: 'running', worktree: null },
        tabRecord,
        tabContent: null,
        targetEnvironmentId: 'env-target',
        sourceEnvironmentId: 'env-source',
        paths,
        destinationPath: join(paths.dataDir, 'out.zip'),
        isWorktreeDirty: async () => false,
        buildWorktreeBundle: async () => null,
        persistSealPending: () => {},
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('running')
    } finally {
      rmSync(paths.dataDir, { recursive: true, force: true })
    }
  })

  it('refuses when the worktree has uncommitted changes', async () => {
    const paths = makeTestPaths('export-dirty')
    try {
      writeConversationFixture(paths.conversationsDir, 'root-1')
      const tabRecord = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })
      writeTabsFile(paths.tabsFile, [tabRecord])

      const result = await runTransferExport({
        tab: { id: 'tab-1', status: 'idle', worktree: { worktreePath: '/wt/x', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo' } },
        tabRecord,
        tabContent: null,
        targetEnvironmentId: 'env-target',
        sourceEnvironmentId: 'env-source',
        paths,
        destinationPath: join(paths.dataDir, 'out.zip'),
        isWorktreeDirty: async () => true,
        buildWorktreeBundle: async () => null,
        carryWorktree: true,
    persistSealPending: () => {},
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('dirty_worktree')
    } finally {
      rmSync(paths.dataDir, { recursive: true, force: true })
    }
  })

  it('refuses when sealPending already targets a different environment', async () => {
    const paths = makeTestPaths('export-sealed')
    try {
      writeConversationFixture(paths.conversationsDir, 'root-1')
      const tabRecord = minimalPersistedTab({
        id: 'tab-1',
        conversationId: 'root-1',
        sealPending: { targetEnvironmentId: 'env-other', since: Date.now() },
      })
      writeTabsFile(paths.tabsFile, [tabRecord])

      const result = await runTransferExport({
        tab: { id: 'tab-1', status: 'idle', worktree: null },
        tabRecord,
        tabContent: null,
        targetEnvironmentId: 'env-target',
        sourceEnvironmentId: 'env-source',
        paths,
        destinationPath: join(paths.dataDir, 'out.zip'),
        isWorktreeDirty: async () => false,
        buildWorktreeBundle: async () => null,
        persistSealPending: () => {},
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('seal_pending')
    } finally {
      rmSync(paths.dataDir, { recursive: true, force: true })
    }
  })
})
