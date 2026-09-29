/**
 * A conversation lands in a directory that exists on the machine it moved
 * to — never the one it had on the machine it left.
 *
 * A working directory is a path on the source. Carried across, it made the
 * Inbox file the conversation under a directory that exists nowhere here,
 * which reads as "the transfer vanished": the Inbox files a conversation
 * under its checkout path, so a foreign path becomes its own project named
 * for someone else's filesystem.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'
import type { TransferPaths } from '../paths'

const SOURCE_DIR = '/Users/someone-else/source/personal/ion'

async function exportPlainConversation(paths: TransferPaths): Promise<string> {
  writeConversationFixture(paths.conversationsDir, 'root-1')
  writeTabsFile(paths.tabsFile, [{ ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }), workingDirectory: SOURCE_DIR }])
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

describe('transfer import: the destination decides the directory', () => {
  it('lands the conversation in the directory the destination chose', async () => {
    const source = makeTestPaths('dest-dir-source')
    const target = makeTestPaths('dest-dir-target')
    const here = join(target.dataDir, 'projects', 'ion')
    mkdirSync(here, { recursive: true })
    const archivePath = await exportPlainConversation(source)

    const result = await runTransferImport({
      archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      landing: { kind: 'checkout', dir: here },
      checkoutWorktreeFromBundle: async () => null,
    })

    expect(result.ok).toBe(true)
    const imported = readTabsState(target.tabsFile).tabs[0]
    expect(imported.workingDirectory).toBe(here)
    expect(imported.workingDirectory).not.toBe(SOURCE_DIR)
  })

  it('refuses rather than importing a conversation pointed at the source\'s path', async () => {
    const source = makeTestPaths('dest-dir-none-source')
    const target = makeTestPaths('dest-dir-none-target')
    const archivePath = await exportPlainConversation(source)

    const result = await runTransferImport({
      archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      checkoutWorktreeFromBundle: async () => null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('no_destination_directory')
    expect(readTabsState(target.tabsFile).tabs).toHaveLength(0)
  })

  it('refuses a directory that does not exist on this machine', async () => {
    const source = makeTestPaths('dest-dir-gone-source')
    const target = makeTestPaths('dest-dir-gone-target')
    const archivePath = await exportPlainConversation(source)

    // The project was registered when the dialog asked, and removed before
    // the archive arrived.
    const result = await runTransferImport({
      archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      landing: { kind: 'checkout', dir: join(target.dataDir, 'projects', 'gone') },
      checkoutWorktreeFromBundle: async () => null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('no_destination_directory')
    expect(result.refusal.message).toContain('does not exist')
  })

  it('ignores the chosen directory for a worktree conversation, which lands in its checkout', async () => {
    const source = makeTestPaths('dest-dir-wt-source')
    const target = makeTestPaths('dest-dir-wt-target')
    writeConversationFixture(source.conversationsDir, 'root-1')
    writeTabsFile(source.tabsFile, [{ ...minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' }), workingDirectory: SOURCE_DIR }])
    writeFileSync(source.settingsFile, JSON.stringify({ projects: { '/repo/source': { repoRemote: 'github.com/org/repo' } } }))
    writeFileSync(target.settingsFile, JSON.stringify({ projects: { '/repo/target': { repoRemote: 'github.com/org/repo' } } }))
    const bundlePath = join(source.dataDir, 'wt.bundle')
    writeFileSync(bundlePath, Buffer.from('bundle payload'))
    const destinationPath = join(source.dataDir, 'export.zip')
    const exported = await runTransferExport({
      tab: { id: 'tab-1', status: 'idle', worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' } },
      tabRecord: readTabsState(source.tabsFile).tabs[0],
      tabContent: null,
      targetEnvironmentId: 'env-target',
      sourceEnvironmentId: 'env-source',
      paths: source,
      destinationPath,
      isWorktreeDirty: async () => false,
      buildWorktreeBundle: async () => ({ bundlePath }),
      carryWorktree: true,
    persistSealPending: (sealPending) => persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', sealPending),
    })
    if (!exported.ok) throw new Error('export refused')

    const result = await runTransferImport({
      archivePath: exported.archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      landing: { kind: 'checkout', dir: '/somewhere/else' },
      checkoutWorktreeFromBundle: async () => ({ worktreePath: '/wt/target' }),
    })

    expect(result.ok).toBe(true)
    expect(readTabsState(target.tabsFile).tabs[0].workingDirectory).toBe('/wt/target')
  })
})
