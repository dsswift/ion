import { describe, expect, it } from 'vitest'
import type { IntegrationMember, IntegrationWorkspace, TabState, WorktreeInventoryEntry } from '../../../shared/types'
import { buildInboxNavigator } from './inbox-navigator'

function tab(id: string, directory: string, overrides: Partial<TabState> = {}): TabState {
  return { id, title: id, workingDirectory: directory, worktree: null, isTerminalOnly: false, ...overrides } as TabState
}

function entry(path: string, title: string, sourceBranch = 'main'): WorktreeInventoryEntry {
  return { worktreePath: path, branchName: `wt/${title}`, label: title, title, sourceBranch, head: '', lastCommitSubject: '', isDirty: false, unlandedCommitCount: 0, needsSync: false, safeToDiscard: false }
}

function workspace(repo: string, benchPath: string, members: IntegrationMember[] = []): IntegrationWorkspace {
  return { repoPath: repo, sourceBranch: 'main', benchPath, benchBranch: 'ion/bench/main', baseSha: '', lastBuiltAt: 0, members } as IntegrationWorkspace
}

describe('buildInboxNavigator', () => {
  it('uses inventory to show non-landed worktrees without conversations', () => {
    const repo = '/repo'
    const one = entry('/worktrees/one', 'One')
    const two = entry('/worktrees/two', 'Two')
    const source = tab('source', repo)
    const worktree = tab('worktree', one.worktreePath, {
      worktree: { repoPath: repo, worktreePath: one.worktreePath, branchName: one.branchName, sourceBranch: 'main' },
    })

    const projects = buildInboxNavigator([worktree, source], new Map(), new Map([[repo, [one, two]]]))

    expect(projects).toHaveLength(1)
    expect(projects[0]!.groups.map((group) => [group.kind, group.label, group.tabs.map((item) => item.id)])).toEqual([
      ['worktree', 'One', ['worktree']],
      ['worktree', 'Two', []],
      ['source', 'Source Repository', ['source']],
    ])
  })

  it('shows non-landed inventory worktrees with zero conversations', () => {
    const repo = '/repo'
    const open = entry('/worktrees/open', 'Open')
    const landed = { ...entry('/worktrees/landed', 'Landed'), landedAt: 1 }

    const projects = buildInboxNavigator([], new Map(), new Map([[repo, [open, landed]]]))

    expect(projects).toHaveLength(1)
    expect(projects[0]!.groups.map((group) => [group.kind, group.label, group.tabs])).toEqual([
      ['worktree', 'Open', []],
    ])
  })

  it('uses the inventory label before the branch for an empty worktree group', () => {
    const repo = '/repo'
    const worktree = { ...entry('/worktrees/open', ''), label: 'Friendly title', title: '', branchName: 'wt/open' }

    const projects = buildInboxNavigator([], new Map(), new Map([[repo, [worktree]]]))

    expect(projects[0]!.groups[0]!.label).toBe('Friendly title')
  })
  it('deduplicates inventory records by worktree path', () => {
    const repo = '/repo'
    const worktree = entry('/worktrees/one', 'One')
    const conversation = tab('worktree', worktree.worktreePath, {
      worktree: { repoPath: repo, worktreePath: worktree.worktreePath, branchName: worktree.branchName, sourceBranch: 'main' },
    })

    const projects = buildInboxNavigator([conversation], new Map(), new Map([[repo, [worktree, { ...worktree }]]]))

    expect(projects[0]!.groups).toHaveLength(1)
    expect(projects[0]!.groups[0]!.tabs.map((item) => item.id)).toEqual(['worktree'])
  })

  it('keeps a registered worktree group when the inventory cache is not ready', () => {
    const repo = '/repo'
    const path = '/worktrees/one'
    const conversation = tab('worktree', path, {
      worktree: { repoPath: repo, worktreePath: path, branchName: 'wt/one', sourceBranch: 'main' },
    })

    const projects = buildInboxNavigator([conversation], new Map(), new Map())

    expect(projects[0]!.project.key).toBe(repo)
    expect(projects[0]!.groups.map((group) => [group.kind, group.key, group.tabs.map((item) => item.id)])).toEqual([
      ['worktree', path, ['worktree']],
    ])
  })

  it('preserves selected conversation order for worktree headers and children', () => {
    const repo = '/repo'
    const one = entry('/worktrees/one', 'One')
    const two = entry('/worktrees/two', 'Two')
    const oneOld = tab('one-old', one.worktreePath, { worktree: { repoPath: repo, worktreePath: one.worktreePath, branchName: one.branchName, sourceBranch: 'main' } })
    const twoNew = tab('two-new', two.worktreePath, { worktree: { repoPath: repo, worktreePath: two.worktreePath, branchName: two.branchName, sourceBranch: 'main' } })
    const oneNew = tab('one-new', one.worktreePath, { worktree: { repoPath: repo, worktreePath: one.worktreePath, branchName: one.branchName, sourceBranch: 'main' } })

    const projects = buildInboxNavigator([twoNew, oneNew, oneOld], new Map(), new Map([[repo, [one, two]]]))

    expect(projects[0]!.groups.map((group) => group.label)).toEqual(['Two', 'One'])
    expect(projects[0]!.groups[1]!.tabs.map((item) => item.id)).toEqual(['one-new', 'one-old'])
  })

  it('sorts bench worktrees first in integration order', () => {
    const repo = '/repo'
    const first = entry('/worktrees/first', 'First')
    const second = entry('/worktrees/second', 'Second')
    const outside = entry('/worktrees/outside', 'Outside')
    const membership = (worktree: WorktreeInventoryEntry): IntegrationMember => ({
      worktreePath: worktree.worktreePath,
      branchName: worktree.branchName,
      pin: 'current',
      merge: 'unbuilt',
      pinnedSha: '',
      pinnedTreeHash: '',
      pinnedBaseSha: '',
      currentTreeHash: '',
    })
    const bench = workspace(repo, '/bench/main', [membership(first), membership(second)])
    const conversation = (worktree: WorktreeInventoryEntry): TabState => tab(worktree.label, worktree.worktreePath, {
      worktree: { repoPath: repo, worktreePath: worktree.worktreePath, branchName: worktree.branchName, sourceBranch: 'main' },
    })

    const projects = buildInboxNavigator(
      [conversation(outside), conversation(second), conversation(first)],
      new Map([[repo, [bench]]]),
      new Map([[repo, [outside, second, first]]]),
    )

    expect(projects[0]!.groups.filter((group) => group.kind === 'worktree').map((group) => group.label)).toEqual([
      'First',
      'Second',
      'Outside',
    ])
  })

  it('selects the Bench that contains an enrolled worktree and carries its marker', () => {
    const repo = '/repo'
    const member = entry('/worktrees/one', 'One')
    const membership = { worktreePath: member.worktreePath, branchName: member.branchName, pin: 'current', merge: 'unbuilt', pinnedSha: '', pinnedTreeHash: '', pinnedBaseSha: '', currentTreeHash: '' } as IntegrationMember
    const bench = workspace(repo, '/bench/main', [membership])
    const conversation = tab('worktree', member.worktreePath, {
      worktree: { repoPath: repo, worktreePath: member.worktreePath, branchName: member.branchName, sourceBranch: 'main' },
    })
    const projects = buildInboxNavigator([conversation], new Map([[repo, [bench]]]), new Map([[repo, [member]]]))
    const worktree = projects[0]!.groups.find((group) => group.kind === 'worktree')!
    expect(worktree.membership).toBeDefined()
  })

  it('files direct and nested worktree conversations under one worktree', () => {
    const repo = '/repo'
    const worktree = entry('/worktrees/one', 'One')
    const info = { repoPath: repo, worktreePath: worktree.worktreePath, branchName: 'wt/one', sourceBranch: 'main' }
    const projects = buildInboxNavigator([
      tab('worktree-root', worktree.worktreePath, { worktree: info }),
      tab('worktree-nested', `${worktree.worktreePath}/packages/app`, { worktree: info }),
    ], new Map(), new Map([[repo, [worktree]]]))
    expect(projects[0]!.groups).toHaveLength(1)
    expect(projects[0]!.groups[0]!.tabs.map((item) => item.id)).toEqual(['worktree-root', 'worktree-nested'])
  })

  it('always shows the Bench group, ordered before worktrees and Source Repository', () => {
    const repo = '/repo'
    const bench = workspace(repo, '/bench/main')
    const one = entry('/worktrees/one', 'One')
    const worktreeConversation = tab('worktree', one.worktreePath, {
      worktree: { repoPath: repo, worktreePath: one.worktreePath, branchName: one.branchName, sourceBranch: 'main' },
    })
    const projects = buildInboxNavigator([
      tab('source', repo),
      worktreeConversation,
      tab('bench-conversation', bench.benchPath),
    ], new Map([[repo, [bench]]]), new Map([[repo, [one]]]))

    expect(projects[0]!.groups.map((group) => [group.kind, group.tabs.map((item) => item.id)])).toEqual([
      ['bench', ['bench-conversation']],
      ['worktree', ['worktree']],
      ['source', ['source']],
    ])
  })

  it('shows the Bench group even when its only open conversation is a terminal', () => {
    const repo = '/repo'
    const bench = workspace(repo, '/bench/main')
    const benchTerminal = tab('bench-terminal', bench.benchPath, { isTerminalOnly: true })

    const projects = buildInboxNavigator([benchTerminal], new Map([[repo, [bench]]]), new Map([[repo, []]]))

    expect(projects).toHaveLength(1)
    expect(projects[0]!.groups.map((group) => group.kind)).toEqual(['bench'])
    expect(projects[0]!.groups[0]!.tabs).toEqual([])
  })

  it('limits project groups to every selected project scope', () => {
    const selectedRepo = '/repos/ion'
    const secondSelectedRepo = '/repos/second'
    const otherRepo = '/repos/other'
    const projects = buildInboxNavigator(
      [
        tab('ion-conversation', selectedRepo),
        tab('second-conversation', secondSelectedRepo),
        tab('other-conversation', otherRepo),
      ],
      new Map(),
      new Map(),
      new Map(),
      new Set([selectedRepo, secondSelectedRepo]),
    )

    expect(projects.map((project) => project.project.key)).toEqual([selectedRepo, secondSelectedRepo])
    expect(projects.flatMap((project) => project.flatTabs.map((item) => item.id))).toEqual([
      'ion-conversation',
      'second-conversation',
    ])
  })

  it('applies project scope after inventory resolves nested worktree ownership', () => {
    const selectedRepo = '/repos/ion'
    const otherRepo = '/repos/other'
    const selectedWorktree = entry('/worktrees/ion-feature', 'Ion Feature')
    const projects = buildInboxNavigator(
      [
        tab('ion-conversation', `${selectedWorktree.worktreePath}/desktop`),
        tab('other-conversation', otherRepo),
      ],
      new Map(),
      new Map([[selectedRepo, [selectedWorktree]]]),
      new Map(),
      new Set([selectedRepo]),
    )

    expect(projects.map((project) => project.project.key)).toEqual([selectedRepo])
    expect(projects[0]!.groups[0]!.tabs.map((item) => item.id)).toEqual(['ion-conversation'])
  })

  it('keeps unmanaged projects as a flat conversation list', () => {
    const projects = buildInboxNavigator([tab('plain', '/plain')], new Map(), new Map())
    expect(projects[0]!.groups).toEqual([])
    expect(projects[0]!.flatTabs.map((item) => item.id)).toEqual(['plain'])
  })

  it('keeps generic terminals out of navigator conversation rows', () => {
    const terminal = tab('terminal', '/repo', { isTerminalOnly: true })
    const projects = buildInboxNavigator([tab('conversation', '/repo'), terminal], new Map(), new Map())
    expect(projects[0]!.flatTabs.map((item) => item.id)).toEqual(['conversation'])
  })
})
