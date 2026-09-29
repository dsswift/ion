/**
 * A conversation can leave its worktree on its own.
 *
 * Moving a worktree conversation used to mean moving the whole worktree and
 * every conversation in it. That defeats the point of moving one: a bug
 * found while working in a worktree is often exactly the thing to pull OUT
 * of it. These pin the conversation-only export: nothing of the worktree is
 * packaged, the worktree's uncommitted state does not block it, and the
 * worktree stays behind with its other conversations.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { removeTransferredSource } from '../remove-source'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'
import type { TransferPaths } from '../paths'

const WT = { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' }

function seed(paths: TransferPaths): void {
  writeConversationFixture(paths.conversationsDir, 'root-1')
  writeConversationFixture(paths.conversationsDir, 'root-2')
  writeTabsFile(paths.tabsFile, [
    { ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }), worktree: WT, workingDirectory: WT.worktreePath },
    { ...minimalPersistedTab({ id: 'tab-2', conversationId: 'root-2' }), worktree: WT, workingDirectory: WT.worktreePath },
  ])
}

async function exportConversationOnly(paths: TransferPaths, overrides: { isWorktreeDirty?: () => Promise<boolean> } = {}) {
  const buildWorktreeBundle = vi.fn(async () => ({ bundlePath: '/never' }))
  const result = await runTransferExport({
    tab: { id: 'tab-1', status: 'idle', worktree: WT },
    tabRecord: readTabsState(paths.tabsFile).tabs[0],
    tabContent: null,
    targetEnvironmentId: 'env-target',
    sourceEnvironmentId: 'env-source',
    paths,
    destinationPath: join(paths.dataDir, 'export.zip'),
    isWorktreeDirty: overrides.isWorktreeDirty ?? (async () => false),
    buildWorktreeBundle,
    persistSealPending: (sealPending) => persistSealPendingOnTabsFile(paths.tabsFile, 'tab-1', sealPending),
  })
  return { result, buildWorktreeBundle }
}

describe('a conversation leaving its worktree', () => {
  it('packages no worktree and carries no worktree identity', async () => {
    const source = makeTestPaths('leave-wt-export')
    seed(source)

    const { result, buildWorktreeBundle } = await exportConversationOnly(source)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(buildWorktreeBundle).not.toHaveBeenCalled()
    expect(result.manifest.worktree).toBeNull()
    expect(result.manifest.tabRecord.worktree).toBeUndefined()
    expect(Object.keys(result.manifest.files).some((n) => n === 'worktree.bundle')).toBe(false)
  })

  it('is not blocked by uncommitted changes in the worktree it is leaving', async () => {
    const source = makeTestPaths('leave-wt-dirty')
    seed(source)

    const { result } = await exportConversationOnly(source, { isWorktreeDirty: async () => true })

    expect(result.ok).toBe(true)
  })

  it('lands as a plain conversation, and leaves the worktree and its other conversation behind', async () => {
    const source = makeTestPaths('leave-wt-source')
    const target = makeTestPaths('leave-wt-target')
    seed(source)
    const landing = join(target.dataDir, 'projects', 'repo')
    mkdirSync(landing, { recursive: true })

    const { result } = await exportConversationOnly(source)
    if (!result.ok) throw new Error('export refused')
    const imported = await runTransferImport({ archivePath: result.archivePath, paths: target, callerSubject: 'importer@example.com', landing: { kind: 'checkout', dir: landing }, checkoutWorktreeFromBundle: async () => null })
    expect(imported.ok).toBe(true)
    expect(readTabsState(target.tabsFile).tabs[0]).toMatchObject({ workingDirectory: landing })
    expect(readTabsState(target.tabsFile).tabs[0].worktree ?? null).toBeNull()

    const retire = vi.fn().mockResolvedValue({ ok: true })
    const removed = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source, retireWorktreeFn: retire })
    expect(removed.ok).toBe(true)
    expect(retire).not.toHaveBeenCalled()
    const left = readTabsState(source.tabsFile).tabs
    expect(left.map((t) => t.id)).toEqual(['tab-2'])
    expect(left[0].worktree?.worktreePath).toBe(WT.worktreePath)
    expect(existsSync(join(source.conversationsDir, 'root-2.llm.jsonl'))).toBe(true)
  })
})
