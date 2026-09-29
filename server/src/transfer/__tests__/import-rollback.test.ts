/**
 * An import that refuses after committing leaves nothing behind.
 *
 * The committed copy is verified against the source's digests before the
 * import reports ok. When that check fails, the files already written must
 * go: left in the store, they make a retry refuse as `conversation_exists`,
 * which the source reads as "already landed" and answers by deleting its own
 * copy, leaving only the one that failed verification.
 */
import { describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// The staged check passes; the check of the committed copy fails once.
let committedChecks = 0
vi.mock('../entries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../entries')>()
  return {
    ...real,
    verifyAgainstDigests: async (...args: Parameters<typeof real.verifyAgainstDigests>) => {
      const isCommittedCheck = args[2] !== undefined
      if (isCommittedCheck && committedChecks++ === 0) return { ok: false as const, mismatched: ['conversations/root-1.llm.jsonl'], missing: [], checked: 0 }
      return real.verifyAgainstDigests(...args)
    },
  }
})

const { runTransferExport } = await import('../export')
const { runTransferImport } = await import('../import')
const { readTabsState, persistSealPendingOnTabsFile } = await import('../tabs-file')
const { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } = await import('./fixtures')

describe('transfer import: a committed copy that fails verification', () => {
  it('is rolled back, so a retry imports instead of reading as already landed', async () => {
    const source = makeTestPaths('rollback-source')
    const target = makeTestPaths('rollback-target')
    writeConversationFixture(source.conversationsDir, 'root-1')
    // Files that ride alongside the conversation, so the rollback is shown to
    // remove them too: a chart, an owned plan, and an attached file.
    mkdirSync(join(source.dataDir, 'resources', 'root-1'), { recursive: true })
    writeFileSync(join(source.dataDir, 'resources', 'root-1', 'chart-k1.json'), '{}')
    mkdirSync(join(source.conversationsDir, 'root-1', 'plans'), { recursive: true })
    writeFileSync(join(source.conversationsDir, 'root-1', 'plans', 'p.md'), '# plan')
    const attached = join(source.dataDir, 'user-attachments', 'a.pdf')
    mkdirSync(join(attached, '..'), { recursive: true })
    writeFileSync(attached, 'pdf')
    appendFileSync(join(source.conversationsDir, 'root-1.tree.jsonl'), JSON.stringify({ id: 'e2', parentId: 'e1', type: 'message', timestamp: 2, data: { content: `[Attached file: ${attached}]` } }) + '\n')
    writeTabsFile(source.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })])
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
    if (!exported.ok) throw new Error('export refused')
    const dir = join(target.dataDir, 'here')
    mkdirSync(dir, { recursive: true })
    const importArgs = { archivePath: exported.archivePath, paths: target, callerSubject: 'importer@example.com', landing: { kind: 'checkout' as const, dir }, checkoutWorktreeFromBundle: async () => null }

    const first = await runTransferImport(importArgs)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.refusal.code).toBe('verification_failed')
    expect(existsSync(join(target.conversationsDir, 'root-1.llm.jsonl'))).toBe(false)
    expect(existsSync(join(target.conversationsDir, 'root-1'))).toBe(false)
    expect(existsSync(join(target.dataDir, 'resources', 'root-1'))).toBe(false)

    const retry = await runTransferImport(importArgs)
    expect(retry.ok).toBe(true)
  })
})
