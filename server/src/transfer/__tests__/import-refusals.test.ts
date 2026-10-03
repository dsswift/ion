import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { transferInboxDir } from '../paths'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'

async function buildArchive(source: ReturnType<typeof makeTestPaths>, id: string): Promise<string> {
  writeConversationFixture(source.conversationsDir, id)
  const tabRecord = minimalPersistedTab({ id: 'tab-1', conversationId: id })
  writeTabsFile(source.tabsFile, [tabRecord])
  const destinationPath = join(source.dataDir, 'out.zip')
  const result = await runTransferExport({
    tab: { id: 'tab-1', status: 'idle', worktree: null },
    tabRecord,
    tabContent: null,
    targetEnvironmentId: 'env-target',
    sourceEnvironmentId: 'env-source',
    paths: source,
    destinationPath,
    isWorktreeDirty: async () => false,
    buildWorktreeBundle: async () => null,
    persistSealPending: () => {},
  })
  if (!result.ok) throw new Error('test setup: export unexpectedly refused')
  return result.archivePath
}

describe('runTransferImport refusals', () => {
  it('refuses when the root conversation id already exists locally, and leaves no staging dir', async () => {
    const source = makeTestPaths('import-collision-source')
    const target = makeTestPaths('import-collision-target')
    try {
      const archivePath = await buildArchive(source, 'root-1')
      // The target already has this conversation.
      writeConversationFixture(target.conversationsDir, 'root-1')

      const result = await runTransferImport({
        archivePath,
        paths: target,
        callerSubject: 'importer@example.com',
        checkoutWorktreeFromBundle: async () => null,
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('conversation_exists')

      const inbox = transferInboxDir(target)
      expect(existsSync(inbox) ? readdirSync(inbox) : []).toHaveLength(0)
      // Nothing else was written either.
      expect(existsSync(target.tabsFile)).toBe(false)
    } finally {
      rmSync(source.dataDir, { recursive: true, force: true })
      rmSync(target.dataDir, { recursive: true, force: true })
    }
  })

  it('deletes the staging dir and writes nothing when the archive is corrupted mid-way', async () => {
    const source = makeTestPaths('import-corrupt-source')
    const target = makeTestPaths('import-corrupt-target')
    try {
      const archivePath = await buildArchive(source, 'root-2')
      // Corrupt everything after the local file header of the FIRST entry
      // (transfer.json) — the central directory (which yauzl reads to
      // enumerate entries) is now inconsistent with the entry bytes, so
      // reading any entry's compressed data fails.
      const original = readFileSync(archivePath)
      const truncated = Buffer.concat([original.subarray(0, 80), Buffer.alloc(original.length - 80, 0)])
      writeFileSync(archivePath, truncated)

      const result = await runTransferImport({
        archivePath,
        paths: target,
        callerSubject: 'importer@example.com',
        checkoutWorktreeFromBundle: async () => null,
      })

      expect(result.ok).toBe(false)

      const inbox = transferInboxDir(target)
      expect(existsSync(inbox) ? readdirSync(inbox) : []).toHaveLength(0)
      expect(existsSync(target.tabsFile)).toBe(false)
      expect(existsSync(join(target.conversationsDir, 'root-2.llm.jsonl'))).toBe(false)
    } finally {
      rmSync(source.dataDir, { recursive: true, force: true })
      rmSync(target.dataDir, { recursive: true, force: true })
    }
  })

  it('refuses with unknown_repo when the worktree repoRemote matches no local project', async () => {
    const source = makeTestPaths('import-unknown-repo-source')
    const target = makeTestPaths('import-unknown-repo-target')
    try {
      writeConversationFixture(source.conversationsDir, 'root-3')
      const tabRecord = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-3' })
      writeTabsFile(source.tabsFile, [tabRecord])
      writeFileSync(source.settingsFile, JSON.stringify({ projects: { '/repo/source': { repoRemote: 'github.com/org/nope' } } }))
      const bundlePath = join(source.dataDir, 'fake.bundle')
      writeFileSync(bundlePath, Buffer.from('bundle bytes'))

      const exportResult = await runTransferExport({
        tab: { id: 'tab-1', status: 'idle', worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' } },
        tabRecord,
        tabContent: null,
        targetEnvironmentId: 'env-target',
        sourceEnvironmentId: 'env-source',
        paths: source,
        destinationPath: join(source.dataDir, 'out.zip'),
        isWorktreeDirty: async () => false,
        buildWorktreeBundle: async () => ({ bundlePath }),
        carryWorktree: true,
    persistSealPending: () => {},
      })
      if (!exportResult.ok) throw new Error('test setup: export unexpectedly refused')

      // Target settings has no project with a matching repoRemote.
      writeFileSync(target.settingsFile, JSON.stringify({ projects: {} }))

      const result = await runTransferImport({
        archivePath: exportResult.archivePath,
        paths: target,
        callerSubject: 'importer@example.com',
        checkoutWorktreeFromBundle: async () => {
          throw new Error('should not be called')
        },
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('unknown_repo')
      expect(existsSync(target.tabsFile)).toBe(false)
    } finally {
      rmSync(source.dataDir, { recursive: true, force: true })
      rmSync(target.dataDir, { recursive: true, force: true })
    }
  })

  it('refuses a conversation that brings a worktree to a server that does not offer worktrees', async () => {
    const source = makeTestPaths('import-no-worktrees-source')
    const target = makeTestPaths('import-no-worktrees-target')
    try {
      writeConversationFixture(source.conversationsDir, 'root-3')
      const tabRecord = minimalPersistedTab({ id: 'tab-1', conversationId: 'root-3' })
      writeTabsFile(source.tabsFile, [tabRecord])
      writeFileSync(source.settingsFile, JSON.stringify({ projects: { '/repo/source': { repoRemote: 'github.com/org/nope' } } }))
      const bundlePath = join(source.dataDir, 'fake.bundle')
      writeFileSync(bundlePath, Buffer.from('bundle bytes'))

      const exportResult = await runTransferExport({
        tab: { id: 'tab-1', status: 'idle', worktree: { worktreePath: '/wt/source', branchName: 'wt/x', sourceBranch: 'main', repoPath: '/repo/source' } },
        tabRecord,
        tabContent: null,
        targetEnvironmentId: 'env-target',
        sourceEnvironmentId: 'env-source',
        paths: source,
        destinationPath: join(source.dataDir, 'out.zip'),
        isWorktreeDirty: async () => false,
        buildWorktreeBundle: async () => ({ bundlePath }),
        carryWorktree: true,
    persistSealPending: () => {},
      })
      if (!exportResult.ok) throw new Error('test setup: export unexpectedly refused')

      // Target settings has no project with a matching repoRemote.
      writeFileSync(target.settingsFile, JSON.stringify({ projects: {} }))

      const result = await runTransferImport({
        archivePath: exportResult.archivePath,
        paths: target,
        callerSubject: 'importer@example.com',
        worktreesOffered: false,
        checkoutWorktreeFromBundle: async () => {
          throw new Error('should not be called')
        },
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('worktrees_not_offered')
      expect(existsSync(target.tabsFile)).toBe(false)
    } finally {
      rmSync(source.dataDir, { recursive: true, force: true })
      rmSync(target.dataDir, { recursive: true, force: true })
    }
  })
})

describe('runTransferImport: a conversation that was here before', () => {
  // There is no "coming home" case. A transfer deletes the copy it moves,
  // so a conversation that left this machine left nothing behind — and a
  // local conversation with the same id is a duplicate, refused.
  it('refuses conversation_exists even for a conversation this machine once held', async () => {
    const source = makeTestPaths('import-return-source')
    const target = makeTestPaths('import-return-target')
    try {
      const archivePath = await buildArchive(source, 'root-1')
      writeConversationFixture(target.conversationsDir, 'root-1')
      writeTabsFile(target.tabsFile, [
        minimalPersistedTab({ id: 'other', conversationId: 'other-conv' }),
        minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1', customTitle: 'the copy that is here' }),
      ])

      const result = await runTransferImport({
        archivePath,
        paths: target,
        callerSubject: 'importer@example.com',
        checkoutWorktreeFromBundle: async () => null,
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('conversation_exists')
      // Nothing local was touched.
      const tabs = (JSON.parse(readFileSync(target.tabsFile, 'utf-8')) as { tabs: Array<{ id: string; customTitle?: string }> }).tabs
      expect(tabs.map((t) => t.id)).toEqual(['other', 'tab-1'])
      expect(tabs[1].customTitle).toBe('the copy that is here')
    } finally {
      rmSync(source.dataDir, { recursive: true, force: true })
      rmSync(target.dataDir, { recursive: true, force: true })
    }
  })
})
