import { describe, expect, it } from 'vitest'
import type { IntegrationMember, IntegrationWorkspace, TabState, WorktreeInventoryEntry } from '@ion/shared/types'
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

describe('buildInboxNavigator: one project per repository across environments', () => {
  // The same repository cloned on two machines has two paths. Keyed on the
  // path it showed as two projects, and a scope on one hid the other's
  // conversations.
  const scopeOf = (key: string, env: string): string => ((env === 'local' && key === '/Users/u/src/ion') || (env === 'oscar' && key === '/home/g/source/ion') ? 'remote:github.com/o/ion' : key)
  const local = tab('t-local', '/Users/u/src/ion')
  const remote = tab('t-oscar', '/home/g/source/ion', { environmentId: 'oscar' })
  const other = tab('t-notes', '/Users/u/notes')

  it('merges both checkouts under one header, local first, and labels the other machine\'s groups', () => {
    const nodes = buildInboxNavigator([remote, local, other], new Map(), new Map(), new Map(), new Set(), { scopeOf, environmentLabel: (id) => (id === 'oscar' ? 'oscar' : 'This Mac') })
    expect(nodes.map((n) => [n.project.name, n.scopeKey])).toEqual([['ion', 'remote:github.com/o/ion'], ['notes', '/Users/u/notes']])
    const ion = nodes[0]
    expect(ion.project.key).toBe('/Users/u/src/ion')
    const tabIds = [...ion.flatTabs, ...ion.groups.flatMap((g) => g.tabs)].map((t) => t.id).sort()
    expect(tabIds).toEqual(['t-oscar', 't-local'])
    expect(ion.groups.map((g) => g.label).filter((l) => l.endsWith('· oscar')).length + ion.flatTabs.filter((t) => t.id === 't-oscar').length).toBeGreaterThan(0)
  })

  it('a scope on the repository shows every machine\'s conversations, and a stale path scope still matches its own checkout', () => {
    const scoped = buildInboxNavigator([remote, local, other], new Map(), new Map(), new Map(), new Set(['remote:github.com/o/ion']), { scopeOf })
    expect(scoped).toHaveLength(1)
    expect([...scoped[0].flatTabs, ...scoped[0].groups.flatMap((g) => g.tabs)].map((t) => t.id).sort()).toEqual(['t-oscar', 't-local'])
    const stale = buildInboxNavigator([remote, local, other], new Map(), new Map(), new Map(), new Set(['/Users/u/src/ion']), { scopeOf })
    expect([...stale[0].flatTabs, ...stale[0].groups.flatMap((g) => g.tabs)].map((t) => t.id)).toEqual(['t-local'])
  })

  // The header's path is a path on one machine, and a new conversation
  // started from the header is created there.
  it('names the machine the header\'s path is on', () => {
    const merged = buildInboxNavigator([remote, local], new Map(), new Map(), new Map(), new Set(), { scopeOf })
    expect([merged[0].project.key, merged[0].environmentId]).toEqual(['/Users/u/src/ion', 'local'])
    const onlyRemote = buildInboxNavigator([remote], new Map(), new Map(), new Map(), new Set(), { scopeOf })
    expect([onlyRemote[0].project.key, onlyRemote[0].environmentId]).toEqual(['/home/g/source/ion', 'oscar'])
  })

  it('without identities every path is its own project, as before', () => {
    const nodes = buildInboxNavigator([remote, local], new Map(), new Map())
    expect(nodes.map((n) => n.scopeKey).sort()).toEqual(['/Users/u/src/ion', '/home/g/source/ion'])
  })
})

describe('buildInboxNavigator: a repository on another machine', () => {
  // The screenshot bug: a remote repository's worktree rows fell back to blank
  // "no commits yet" placeholders because the inventory never reached them.
  // Once it does, the rows carry the remote's commit facts, and the
  // repository must stay the remote's checkout rather than gaining a phantom
  // local copy that draws every worktree twice.
  const repo = '/Users/r/src/api'
  const wt = { ...entry('/Users/r/.ion/worktrees/api-f83c', 'api-f83c'), lastCommitSubject: 'feat: add network', unlandedCommitCount: 5 }
  const idle = entry('/Users/r/.ion/worktrees/api-b29b', 'api-b29b')
  const conversation = tab('t-remote', wt.worktreePath, {
    environmentId: 'env-remote',
    worktree: { repoPath: repo, worktreePath: wt.worktreePath, branchName: wt.branchName, sourceBranch: 'main' },
  })
  const environmentOfRepo = (path: string): string | null => (path === repo ? 'env-remote' : null)

  it('renders the remote inventory once, under the remote checkout', () => {
    const nodes = buildInboxNavigator([conversation], new Map(), new Map([[repo, [wt, idle]]]), new Map(), new Set(), { environmentOfRepo })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].environmentId).toBe('env-remote')
    expect(nodes[0].checkouts).toEqual([{ environmentId: 'env-remote', key: repo }])
    expect(nodes[0].groups.map((group) => [group.key, group.tabs.map((t) => t.id)])).toEqual([
      [wt.worktreePath, ['t-remote']],
      [idle.worktreePath, []],
    ])
    expect(nodes[0].groups[0].worktree).toMatchObject({ lastCommitSubject: 'feat: add network', unlandedCommitCount: 5 })
  })

  it('files a remote repository with no open conversation under its own machine', () => {
    const nodes = buildInboxNavigator([], new Map(), new Map([[repo, [idle]]]), new Map(), new Set(), { environmentOfRepo })
    expect(nodes.map((node) => [node.environmentId, node.checkouts])).toEqual([['env-remote', [{ environmentId: 'env-remote', key: repo }]]])
  })

  it('hides a remote repository with no open conversation when the Environment filter excludes its machine', () => {
    const localOnly = (environmentId: string): boolean => environmentId === 'local'
    const hidden = buildInboxNavigator([], new Map(), new Map([[repo, [idle]]]), new Map(), new Set(), { environmentOfRepo, environmentIncluded: localOnly })
    expect(hidden).toEqual([])
    const benchOnly = buildInboxNavigator([], new Map([[repo, [workspace(repo, '/home/u/.ion/integration/api')]]]), new Map(), new Map(), new Set(), { environmentOfRepo, environmentIncluded: localOnly })
    expect(benchOnly).toEqual([])
    const shown = buildInboxNavigator([], new Map(), new Map([[repo, [idle]]]), new Map(), new Set(), { environmentOfRepo, environmentIncluded: (environmentId) => environmentId === 'env-remote' })
    expect(shown.map((node) => node.environmentId)).toEqual(['env-remote'])
  })

  it('lists every merged checkout so each is re-read on its own machine', () => {
    const scopeOf = (key: string, env: string): string => ((env === 'local' && key === '/Users/u/src/api') || (env === 'env-remote' && key === repo) ? 'remote:example.org/o/api' : key)
    const local = tab('t-local', '/Users/u/src/api')
    const nodes = buildInboxNavigator([conversation, local], new Map(), new Map([[repo, [wt]]]), new Map(), new Set(), { scopeOf, environmentOfRepo })
    expect(nodes).toHaveLength(1)
    expect(nodes[0].checkouts).toEqual([{ environmentId: 'local', key: '/Users/u/src/api' }, { environmentId: 'env-remote', key: repo }])
  })
})
