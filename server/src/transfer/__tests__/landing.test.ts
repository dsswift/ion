/**
 * Where an arriving conversation lands: a checkout, an existing worktree,
 * or a new worktree — and never anywhere that no longer holds.
 *
 * A dialog's answer can be minutes old by the time the archive arrives: a
 * project removed, a worktree landed, a branch deleted. Every landing is
 * checked again at import and refused if it no longer holds, and a refused
 * landing leaves nothing behind.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { resolveLanding, parseLanding, landingOptionsFor, type LandingDeps } from '../landing'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'
import type { TransferPaths } from '../paths'
import type { RegistryEntry } from '../../worktree/registry'

function scratch(paths: TransferPaths, name: string): string {
  const dir = join(paths.dataDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function deps(over: Partial<LandingDeps> & { project: string; worktrees?: RegistryEntry[] }): LandingDeps {
  return {
    readProjects: () => ({ [over.project]: {} }),
    loadRegistry: () => over.worktrees ?? [],
    hasBranch: over.hasBranch ?? (async () => true),
    createWorktree: over.createWorktree ?? (async () => ({ ok: false, error: 'not stubbed' })),
  }
}

function entry(worktreePath: string, repoPath: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return { worktreePath, repoPath, branchName: 'wt/a', sourceBranch: 'main', createdAt: 1, ...over } as RegistryEntry
}

describe('resolveLanding', () => {
  it('binds a conversation to an existing worktree of a project here', async () => {
    const paths = makeTestPaths('landing-wt')
    const project = scratch(paths, 'ion')
    const wt = scratch(paths, 'wt-a')

    const result = await resolveLanding({ kind: 'worktree', worktreePath: wt }, deps({ project, worktrees: [entry(wt, project)] }))

    expect(result).toEqual({ ok: true, workingDirectory: wt, worktree: { worktreePath: wt, branchName: 'wt/a', sourceBranch: 'main', repoPath: project } })
  })

  it('refuses a worktree that has landed, is missing, or belongs to no project here', async () => {
    const paths = makeTestPaths('landing-wt-refuse')
    const project = scratch(paths, 'ion')
    const wt = scratch(paths, 'wt-a')

    const landed = await resolveLanding({ kind: 'worktree', worktreePath: wt }, deps({ project, worktrees: [entry(wt, project, { landedAt: 5 })] }))
    const unregistered = await resolveLanding({ kind: 'worktree', worktreePath: wt }, deps({ project }))
    const foreign = await resolveLanding({ kind: 'worktree', worktreePath: wt }, deps({ project, worktrees: [entry(wt, '/some/other/repo')] }))
    const missing = await resolveLanding({ kind: 'worktree', worktreePath: join(paths.dataDir, 'gone') }, deps({ project, worktrees: [entry(join(paths.dataDir, 'gone'), project)] }))

    for (const r of [landed, unregistered, foreign, missing]) expect(r.ok).toBe(false)
    if (!landed.ok) expect(landed.message).toContain('already landed')
  })

  it('creates a new worktree from the chosen branch and binds to it', async () => {
    const paths = makeTestPaths('landing-new')
    const project = scratch(paths, 'ion')
    const created = { worktreePath: join(paths.dataDir, 'wt-new'), branchName: 'wt/ion-1234', sourceBranch: 'josh', repoPath: project }
    const createWorktree = vi.fn(async () => ({ ok: true as const, worktree: created }))

    const result = await resolveLanding({ kind: 'new-worktree', projectDir: project, baseBranch: 'josh' }, deps({ project, createWorktree }))

    expect(createWorktree).toHaveBeenCalledWith(project, 'josh')
    expect(result).toEqual({ ok: true, workingDirectory: created.worktreePath, worktree: created })
  })

  it('refuses a new worktree from a branch that does not exist, and creates nothing', async () => {
    const paths = makeTestPaths('landing-new-nobranch')
    const project = scratch(paths, 'ion')
    const createWorktree = vi.fn()

    const result = await resolveLanding({ kind: 'new-worktree', projectDir: project, baseBranch: 'gone' }, deps({ project, hasBranch: async () => false, createWorktree }))

    expect(result.ok).toBe(false)
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('parses only well-formed landings off the wire', () => {
    expect(parseLanding({ kind: 'checkout', dir: '/a' })).toEqual({ kind: 'checkout', dir: '/a' })
    expect(parseLanding({ kind: 'new-worktree', projectDir: '/a' })).toBeNull()
    expect(parseLanding({ kind: 'teleport', dir: '/a' })).toBeNull()
    expect(parseLanding(undefined)).toBeNull()
  })
})

describe('landingOptionsFor', () => {
  it("lists the project's live worktrees newest first, and its branches", async () => {
    const paths = makeTestPaths('landing-options')
    const project = scratch(paths, 'ion')
    const older = scratch(paths, 'wt-old')
    const newer = scratch(paths, 'wt-new')
    const landed = scratch(paths, 'wt-landed')
    const worktrees = [
      entry(older, project, { branchName: 'wt/old', createdAt: 1, title: 'Old work' }),
      entry(newer, project, { branchName: 'wt/new', createdAt: 2 }),
      entry(landed, project, { branchName: 'wt/landed', createdAt: 3, landedAt: 4 }),
      entry(scratch(paths, 'wt-other'), '/another/repo', { createdAt: 5 }),
    ]

    const result = await landingOptionsFor(project, {
      ...deps({ project, worktrees }),
      listBranches: async () => ['josh', 'main'],
      currentBranch: async () => 'josh',
    })

    expect(result).toEqual({ ok: true, value: {
      worktrees: [
        { worktreePath: newer, branchName: 'wt/new', title: null },
        { worktreePath: older, branchName: 'wt/old', title: 'Old work' },
      ],
      branches: ['josh', 'main'],
      currentBranch: 'josh',
    } })
  })

  // A notes folder or any non-git project still takes a conversation in its
  // checkout; it just has no branches to cut a worktree from.
  it('still answers for a project git cannot read, with no branches', async () => {
    const paths = makeTestPaths('landing-options-nogit')
    const project = scratch(paths, 'notes')
    const result = await landingOptionsFor(project, {
      ...deps({ project }),
      listBranches: async () => { throw new Error('not a git repository') },
      currentBranch: async () => null,
    })
    expect(result).toEqual({ ok: true, value: { worktrees: [], branches: [], currentBranch: null } })
  })

  it('refuses a directory that is not a project here', async () => {
    const paths = makeTestPaths('landing-options-refuse')
    const result = await landingOptionsFor(scratch(paths, 'stray'), {
      ...deps({ project: '/elsewhere' }),
      listBranches: async () => [],
      currentBranch: async () => null,
    })
    expect(result.ok).toBe(false)
  })
})

describe('transfer import: a refused landing leaves nothing behind', () => {
  it('commits no conversation files when there is nowhere to land', async () => {
    // Resolving the directory after committing the transcripts left them in
    // the store, orphaned, whenever the landing was refused.
    const source = makeTestPaths('landing-orphan-source')
    const target = makeTestPaths('landing-orphan-target')
    writeConversationFixture(source.conversationsDir, 'root-1')
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

    const result = await runTransferImport({
      archivePath: exported.archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      landing: { kind: 'checkout', dir: join(target.dataDir, 'not-here') },
      checkoutWorktreeFromBundle: async () => null,
    })

    expect(result.ok).toBe(false)
    expect(existsSync(join(target.conversationsDir, 'root-1.llm.jsonl'))).toBe(false)
    expect(readTabsState(target.tabsFile).tabs).toHaveLength(0)

    // And a retry to a landing that holds imports cleanly. Files left behind
    // would refuse it as `conversation_exists`, which the source reads as
    // "already landed" and answers by deleting the only copy.
    const retry = await runTransferImport({
      archivePath: exported.archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      landing: { kind: 'checkout', dir: scratch(target, 'here') },
      checkoutWorktreeFromBundle: async () => null,
    })
    expect(retry.ok).toBe(true)
  })

  it('cuts no new worktree for an import that refuses before it lands', async () => {
    const source = makeTestPaths('landing-nocut-source')
    const target = makeTestPaths('landing-nocut-target')
    writeConversationFixture(source.conversationsDir, 'root-1')
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
    // The conversation is already here, so this import must refuse.
    writeConversationFixture(target.conversationsDir, 'root-1')
    const project = scratch(target, 'ion')
    const createWorktree = vi.fn()

    const result = await runTransferImport({
      archivePath: exported.archivePath,
      paths: target,
      callerSubject: 'importer@example.com',
      landing: { kind: 'new-worktree', projectDir: project, baseBranch: 'main' },
      landingDeps: deps({ project, createWorktree }),
      checkoutWorktreeFromBundle: async () => null,
    })

    expect(result.ok).toBe(false)
    expect(createWorktree).not.toHaveBeenCalled()
  })
})
