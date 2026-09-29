/**
 * A transfer is a move: one conversation, one host.
 *
 * Exercises the whole sequence against two temp environments — export,
 * import with verification, then the removal of the source — and asserts
 * the two halves of the contract that make it a move rather than a copy:
 * the destination's files are byte-for-byte the source's, and afterwards
 * the source holds nothing at all. Also pins the guards that keep the
 * removal from being a way to delete a conversation nobody is transferring.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { removeTransferredSource } from '../remove-source'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'
import type { TransferPaths } from '../paths'

/** A directory that exists on the destination: an import refuses to land a plain conversation anywhere else. */
function landingDir(paths: TransferPaths): string {
  const dir = join(paths.dataDir, 'projects', 'ion')
  mkdirSync(dir, { recursive: true })
  return dir
}

function seedSource(paths: TransferPaths): void {
  writeConversationFixture(paths.conversationsDir, 'root-1')
  writeConversationFixture(paths.conversationsDir, 'child-1', { parentId: 'root-1' })
  mkdirSync(join(paths.conversationsDir, 'root-1', 'images'), { recursive: true })
  writeFileSync(join(paths.conversationsDir, 'root-1', 'images', 'a.png'), Buffer.from([1, 2, 3]))
  writeTabsFile(paths.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })])
}

async function exportFrom(paths: TransferPaths): Promise<string> {
  const destinationPath = join(paths.dataDir, 'export.zip')
  const result = await runTransferExport({
    tab: { id: 'tab-1', status: 'idle', worktree: null },
    tabRecord: readTabsState(paths.tabsFile).tabs[0],
    tabContent: null,
    targetEnvironmentId: 'env-target',
    sourceEnvironmentId: 'env-source',
    paths,
    destinationPath,
    isWorktreeDirty: async () => false,
    buildWorktreeBundle: async () => null,
    persistSealPending: (sealPending) => persistSealPendingOnTabsFile(paths.tabsFile, 'tab-1', sealPending),
  })
  if (!result.ok) throw new Error(`export refused: ${result.refusal.code}`)
  return result.archivePath
}

describe('transfer: export -> import -> remove', () => {
  it('leaves the conversation on exactly one host, byte for byte', async () => {
    const source = makeTestPaths('move-source')
    const target = makeTestPaths('move-target')
    seedSource(source)
    const before = {
      root: readFileSync(join(source.conversationsDir, 'root-1.llm.jsonl')),
      child: readFileSync(join(source.conversationsDir, 'child-1.llm.jsonl')),
      image: readFileSync(join(source.conversationsDir, 'root-1', 'images', 'a.png')),
    }

    const archivePath = await exportFrom(source)
    const importResult = await runTransferImport({ archivePath, paths: target, callerSubject: 'importer@example.com', landing: { kind: 'checkout', dir: landingDir(target) }, checkoutWorktreeFromBundle: async () => null })
    expect(importResult.ok).toBe(true)
    if (!importResult.ok) return
    // Verification ran over what was committed, not just what was claimed.
    expect(importResult.verifiedFiles).toBeGreaterThan(0)

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source })
    expect(removal.ok).toBe(true)

    // The destination holds the same bytes.
    expect(readFileSync(join(target.conversationsDir, 'root-1.llm.jsonl'))).toEqual(before.root)
    expect(readFileSync(join(target.conversationsDir, 'child-1.llm.jsonl'))).toEqual(before.child)
    expect(readFileSync(join(target.conversationsDir, 'root-1', 'images', 'a.png'))).toEqual(before.image)

    // And the source holds nothing: no files, no directory, no tab record.
    for (const id of ['root-1', 'child-1']) {
      expect(existsSync(join(source.conversationsDir, `${id}.llm.jsonl`))).toBe(false)
      expect(existsSync(join(source.conversationsDir, `${id}.tree.jsonl`))).toBe(false)
    }
    expect(existsSync(join(source.conversationsDir, 'root-1'))).toBe(false)
    expect(readTabsState(source.tabsFile).tabs).toHaveLength(0)
  })

  it('refuses to remove a conversation no transfer put in flight', async () => {
    const source = makeTestPaths('move-not-pending')
    seedSource(source)

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source })

    expect(removal.ok).toBe(false)
    if (removal.ok) return
    expect(removal.refusal.code).toBe('not_pending')
    expect(existsSync(join(source.conversationsDir, 'root-1.llm.jsonl'))).toBe(true)
    expect(readTabsState(source.tabsFile).tabs).toHaveLength(1)
  })

  it('refuses when the transfer in flight is to a different environment', async () => {
    const source = makeTestPaths('move-wrong-target')
    seedSource(source)
    await exportFrom(source)

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-somewhere-else', paths: source })

    expect(removal.ok).toBe(false)
    if (removal.ok) return
    expect(removal.refusal.code).toBe('not_pending')
    expect(existsSync(join(source.conversationsDir, 'root-1.llm.jsonl'))).toBe(true)
  })

  it('answers ok when the source is already gone, so a retry can finish a move', async () => {
    const source = makeTestPaths('move-idempotent')
    seedSource(source)
    await exportFrom(source)

    const first = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source })
    const second = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.alreadyGone).toBe(true)
  })

  it('keeps every file when the source worktree cannot be removed', async () => {
    const source = makeTestPaths('move-worktree-refuses')
    writeConversationFixture(source.conversationsDir, 'root-1')
    writeTabsFile(source.tabsFile, [{
      ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }),
      worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' },
    }])
    await persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', { targetEnvironmentId: 'env-target', since: Date.now() })
    const retireWorktree = vi.fn().mockResolvedValue({ ok: false, error: 'uncommitted changes' })

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source, retireWorktree: true, retireWorktreeFn: retireWorktree })

    expect(removal.ok).toBe(false)
    if (removal.ok) return
    expect(removal.refusal.code).toBe('worktree_removal_failed')
    // Nothing else was touched: the conversation and its record survive, so
    // a retry after the operator commits still has something to move.
    expect(existsSync(join(source.conversationsDir, 'root-1.llm.jsonl'))).toBe(true)
    expect(readTabsState(source.tabsFile).tabs).toHaveLength(1)
  })

  it('keeps the worktree when only the conversation is moving', async () => {
    const source = makeTestPaths('move-worktree-conversation-only')
    writeConversationFixture(source.conversationsDir, 'root-1')
    writeTabsFile(source.tabsFile, [{
      ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }),
      worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' },
    }])
    await persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', { targetEnvironmentId: 'env-target', since: Date.now() })
    const retireWorktree = vi.fn().mockResolvedValue({ ok: true })

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source, retireWorktreeFn: retireWorktree })

    expect(removal.ok).toBe(true)
    expect(retireWorktree).not.toHaveBeenCalled()
    // The conversation itself is gone from here.
    expect(existsSync(join(source.conversationsDir, 'root-1.llm.jsonl'))).toBe(false)
  })

  it('never retires a worktree another conversation still lives in', async () => {
    // The bug this guards: in a worktree move each conversation is removed
    // in turn, and retiring on the first deleted the checkout the next one
    // still had to package.
    const source = makeTestPaths('move-worktree-sibling')
    writeConversationFixture(source.conversationsDir, 'root-1')
    writeConversationFixture(source.conversationsDir, 'root-2')
    const wt = { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' }
    writeTabsFile(source.tabsFile, [
      { ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }), worktree: wt },
      { ...minimalPersistedTab({ id: 'tab-2', conversationId: 'root-2' }), worktree: wt },
    ])
    await persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', { targetEnvironmentId: 'env-target', since: Date.now() })
    const retireWorktree = vi.fn().mockResolvedValue({ ok: true })

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source, retireWorktree: true, retireWorktreeFn: retireWorktree })

    expect(removal.ok).toBe(true)
    expect(retireWorktree).not.toHaveBeenCalled()
    expect(readTabsState(source.tabsFile).tabs.map((t) => t.id)).toEqual(['tab-2'])
  })

  it('removes the worktree with the conversation when it has one', async () => {
    const source = makeTestPaths('move-worktree-ok')
    writeConversationFixture(source.conversationsDir, 'root-1')
    writeTabsFile(source.tabsFile, [{
      ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }),
      worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' },
    }])
    await persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', { targetEnvironmentId: 'env-target', since: Date.now() })
    const retireWorktree = vi.fn().mockResolvedValue({ ok: true })

    const removal = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-target', paths: source, retireWorktree: true, retireWorktreeFn: retireWorktree })

    expect(removal.ok).toBe(true)
    if (!removal.ok) return
    expect(retireWorktree).toHaveBeenCalledWith({ repoPath: '/repo/source', worktreePath: '/wt/source', branchName: 'wt/x' })
    expect(removal.removedWorktreePath).toBe('/wt/source')
    expect(existsSync(join(source.conversationsDir, 'root-1.llm.jsonl'))).toBe(false)
  })
})
