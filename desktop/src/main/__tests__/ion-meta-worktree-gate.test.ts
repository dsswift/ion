/**
 * Worktree-gate tests.
 *
 * The property that matters: a conversation running in a worktree cannot write
 * into the base repo it was cut from, or into a sibling worktree belonging to
 * another conversation. Those writes interleave several conversations' work in
 * one dirty tree, and review cannot untangle them afterwards.
 *
 * Over-blocking is as much a defect as under-blocking. The gate is NOT "confine
 * the agent to its cwd" — /tmp, ~/.ion, and unrelated repos must all stay
 * writable, and a conversation that is not in a worktree at all must be
 * completely unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => process.env.ION_WT_TEST_HOME || actual.homedir() }
})

import {
  gateWorktreeWrite, resolveWorktreeContainment, _resetWorktreeCacheForTests,
} from '../../../../engine/extensions/ion-meta/worktree-gate'

const REPO = '/tmp/ion-wt-fixture/project'
const MINE = '/tmp/ion-wt-fixture/worktrees/project-a3372546'
const SIBLING = '/tmp/ion-wt-fixture/worktrees/project-c20cc246'
// Shares a prefix with MINE. The containment check must NOT treat this as
// inside MINE, or writes in an unrelated worktree would be refused.
const PREFIX_TWIN = '/tmp/ion-wt-fixture/worktrees/project-a33725460'
const OTHER_REPO = '/tmp/ion-wt-fixture/unrelated'

function write(file: string): { toolName: string; toolId: string; input: Record<string, unknown> } {
  return { toolName: 'Write', toolId: 't1', input: { file_path: file } }
}

function bash(command: string): { toolName: string; toolId: string; input: Record<string, unknown> } {
  return { toolName: 'Bash', toolId: 't1', input: { command } }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-wtgate-'))
  process.env.ION_WT_TEST_HOME = home
  mkdirSync(join(home, '.ion'), { recursive: true })
  writeFileSync(
    join(home, '.ion', 'worktree-registry.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { worktreePath: MINE, repoPath: REPO, branchName: 'wt/aaa', sourceBranch: 'josh', createdAt: 1 },
        { worktreePath: SIBLING, repoPath: REPO, branchName: 'wt/bbb', sourceBranch: 'josh', createdAt: 2 },
        { worktreePath: PREFIX_TWIN, repoPath: OTHER_REPO, branchName: 'wt/ccc', sourceBranch: 'main', createdAt: 3 },
      ],
    }),
  )
  _resetWorktreeCacheForTests()
})

afterEach(() => {
  delete process.env.ION_WT_TEST_HOME
  rmSync(home, { recursive: true, force: true })
  _resetWorktreeCacheForTests()
})

describe('gateWorktreeWrite — the writes that must be refused', () => {
  it('blocks a write into the base repo', () => {
    const d = gateWorktreeWrite(write(join(REPO, 'engine/internal/foo.go')), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
    // The refusal must name where the agent SHOULD write, or the model cannot act on it.
    expect(d.reason).toContain(MINE)
  })

  it('blocks a write into a sibling worktree of the same repo', () => {
    const d = gateWorktreeWrite(write(join(SIBLING, 'desktop/src/index.ts')), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('sibling worktree')
  })

  it('blocks from a SUBDIRECTORY of the worktree, not just its root', () => {
    const d = gateWorktreeWrite(write(join(REPO, 'a.txt')), join(MINE, 'engine/internal'))
    expect(d.block).toBe(true)
  })

  it('blocks an Edit into the base repo', () => {
    const d = gateWorktreeWrite(
      { toolName: 'Edit', toolId: 't1', input: { file_path: join(REPO, 'x.go') } },
      MINE,
    )
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
  })
})

describe('gateWorktreeWrite — the writes that must pass', () => {
  it('allows a write inside the session own worktree', () => {
    expect(gateWorktreeWrite(write(join(MINE, 'engine/x.go')), MINE).block).toBe(false)
  })

  it('allows a Bash call whose command stays inside the session own worktree', () => {
    // Bash destinations are resolved from the command TEXT (see
    // bash-destination.ts): a command with no `cd` runs in the session cwd, and a
    // `cd` to a path inside the worktree is still inside it.
    expect(
      gateWorktreeWrite(bash('touch x'), MINE).block,
    ).toBe(false)
    expect(
      gateWorktreeWrite(bash('touch x'), join(MINE, 'engine')).block,
    ).toBe(false)
    expect(
      gateWorktreeWrite(bash(`cd ${join(MINE, 'desktop')} && npm test`), MINE).block,
    ).toBe(false)
  })

  it('allows a write to the worktree root itself', () => {
    expect(gateWorktreeWrite(write(MINE), MINE).block).toBe(false)
  })

  it('does not treat a prefix-sharing sibling directory as inside the worktree', () => {
    // …/project-a33725460 must not match …/project-a3372546. It belongs to a
    // different repo entirely, so it is neither the base nor a sibling: it
    // passes, and it must not be misread as "inside mine" either.
    const d = gateWorktreeWrite(write(join(PREFIX_TWIN, 'x.ts')), MINE)
    expect(d.block).toBe(false)
  })

  it('allows writes to an unrelated repo', () => {
    expect(gateWorktreeWrite(write(join(OTHER_REPO, 'x.ts')), MINE).block).toBe(false)
  })

  it('allows writes to /tmp and ~/.ion — the gate is not a cwd jail', () => {
    expect(gateWorktreeWrite(write('/tmp/scratch.txt'), MINE).block).toBe(false)
    expect(gateWorktreeWrite(write(join(home, '.ion', 'notes.md')), MINE).block).toBe(false)
  })

  it('passes everything when the cwd is not a registered worktree', () => {
    // An ordinary repo conversation must be completely unaffected, including a
    // session running in the base repo itself.
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), REPO).block).toBe(false)
    expect(gateWorktreeWrite(write(join(MINE, 'x.go')), REPO).block).toBe(false)
    expect(gateWorktreeWrite(write('/tmp/x'), '/tmp/elsewhere').block).toBe(false)
  })

  it('ignores read-class and dispatch tools', () => {
    for (const toolName of ['Read', 'Grep', 'Glob', 'Agent']) {
      const d = gateWorktreeWrite({ toolName, toolId: 't1', input: { file_path: join(REPO, 'x.go') } }, MINE)
      expect(d.block).toBe(false)
    }
  })

  it('passes when the tool carries no extractable target', () => {
    expect(gateWorktreeWrite({ toolName: 'Write', toolId: 't1', input: {} }, MINE).block).toBe(false)
  })
})

/**
 * The defect these tests pin: a conversation whose cwd was its worktree ran 115
 * commands prefixed `cd /Users/Shared/source/personal/ion &&` and committed twice
 * onto the base repo's branch. The gate passed every one of them, because a
 * `Bash` call was resolved to the session cwd and the command text was never
 * read. The worktree's own reflog showed only its creation entries.
 */
describe('gateWorktreeWrite — Bash commands that leave the worktree', () => {
  it('blocks a cd into the base repo followed by a commit', () => {
    // The exact shape that lost the work.
    const d = gateWorktreeWrite(bash(`cd ${REPO} && git add desktop/src && git commit -m x`), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
    expect(d.targetPath).toBe(REPO)
    expect(d.reason).toContain(MINE)
  })

  it('blocks a cd into a subdirectory of the base repo', () => {
    const d = gateWorktreeWrite(bash(`cd ${join(REPO, 'desktop')} && npm test`), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
  })

  it('blocks a cd into a sibling worktree', () => {
    const d = gateWorktreeWrite(bash(`cd ${SIBLING} && touch x`), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('sibling worktree')
  })

  it('blocks git -C into the base repo, and allows it into the worktree', () => {
    expect(gateWorktreeWrite(bash(`git -C ${REPO} commit -m x`), MINE).block).toBe(true)
    expect(gateWorktreeWrite(bash(`git -C ${MINE} commit -m x`), MINE).block).toBe(false)
  })

  it('blocks --git-dir and --work-tree redirection into the base repo', () => {
    expect(gateWorktreeWrite(bash(`git --work-tree=${REPO} add .`), MINE).block).toBe(true)
    expect(gateWorktreeWrite(bash(`git --git-dir ${join(REPO, '.git')} log`), MINE).block).toBe(true)
  })

  it('blocks when the escaping cd is not the first segment', () => {
    // `cd` is sequential: everything after it runs in the new directory, so a
    // late `cd` is exactly as dangerous as a leading one.
    const d = gateWorktreeWrite(bash(`npm test && cd ${REPO} && git commit -m x`), MINE)
    expect(d.block).toBe(true)
  })

  it('blocks a cd reached through a pipeline or semicolon chain', () => {
    expect(gateWorktreeWrite(bash(`echo hi ; cd ${REPO} && touch x`), MINE).block).toBe(true)
    expect(gateWorktreeWrite(bash(`cat f | cd ${REPO}`), MINE).block).toBe(true)
  })

  it('blocks a relative cd that climbs out into the base repo', () => {
    // MINE is /tmp/ion-wt-fixture/worktrees/project-a3372546, so ../../project
    // is the base repo. Relative paths resolve against the tracked directory.
    const d = gateWorktreeWrite(bash('cd ../../project && git commit -m x'), MINE)
    expect(d.block).toBe(true)
    expect(d.targetKind).toBe('base repo')
  })

  it('allows destinations outside the repo entirely — Downloads, /tmp, ~/.ion', () => {
    // The operator's stated scope: a worktree conversation may read and write
    // anywhere except the repo it was cut from and that repo's other worktrees.
    expect(gateWorktreeWrite(bash('cd ~/Downloads && unzip a.zip'), MINE).block).toBe(false)
    expect(gateWorktreeWrite(bash('cd ~/Documents && cat notes.md'), MINE).block).toBe(false)
    expect(gateWorktreeWrite(bash('cd /tmp && touch scratch'), MINE).block).toBe(false)
    expect(gateWorktreeWrite(bash(`cd ${OTHER_REPO} && git log`), MINE).block).toBe(false)
    expect(gateWorktreeWrite(bash(`cd ${join(home, '.ion')} && cat config.json`), MINE).block).toBe(false)
  })

  it('passes a dynamic destination it cannot resolve, and reports it', () => {
    // Refusing here would block legitimate work in the operator's own worktree,
    // so the call passes — but the unresolved construct is surfaced so the caller
    // can log it and the residual gap stays queryable.
    const varForm = gateWorktreeWrite(bash('cd "$TARGET" && touch x'), MINE)
    expect(varForm.block).toBe(false)
    expect(varForm.unresolvedDestination).toBe('cd "$TARGET"')

    const substForm = gateWorktreeWrite(bash('cd $(git rev-parse --show-toplevel) && touch x'), MINE)
    expect(substForm.block).toBe(false)
    expect(substForm.unresolvedDestination).toContain('rev-parse')
  })

  it('reports no unresolved destination when everything resolved', () => {
    expect(gateWorktreeWrite(bash('npm test'), MINE).unresolvedDestination).toBeUndefined()
    expect(
      gateWorktreeWrite(bash(`cd ${join(MINE, 'desktop')} && npm test`), MINE).unresolvedDestination,
    ).toBeUndefined()
  })

  it('does not split on an operator inside a quoted commit message', () => {
    // `git commit -m "a && b"` must not be read as a chain whose second segment
    // is `b"`. The message stays inside its segment and nothing escapes.
    const d = gateWorktreeWrite(bash('git commit -m "fix a && b"'), MINE)
    expect(d.block).toBe(false)
  })

  it('is unaffected when the session is not in a worktree', () => {
    // A base-repo conversation may cd wherever it likes; this gate is only about
    // worktree containment.
    expect(gateWorktreeWrite(bash(`cd ${REPO} && git commit -m x`), REPO).block).toBe(false)
    expect(gateWorktreeWrite(bash(`cd ${MINE} && git commit -m x`), REPO).block).toBe(false)
  })

  it('passes a Bash call with no command string', () => {
    expect(gateWorktreeWrite({ toolName: 'Bash', toolId: 't1', input: {} }, MINE).block).toBe(false)
  })
})

describe('registry handling', () => {
  it('resolves containment with the base repo and only same-repo siblings', () => {
    const c = resolveWorktreeContainment(MINE)
    expect(c).not.toBeNull()
    expect(c!.repoPath).toBe(REPO)
    expect(c!.siblingPaths).toEqual([SIBLING])
    // The other repo's worktree is not a sibling of mine.
    expect(c!.siblingPaths).not.toContain(PREFIX_TWIN)
  })

  it('returns null for a directory in no registered worktree', () => {
    expect(resolveWorktreeContainment(REPO)).toBeNull()
    expect(resolveWorktreeContainment('/tmp/nowhere')).toBeNull()
  })

  it('fails OPEN when the registry is unreadable', () => {
    // A false refusal in the place the operator is working is worse than a
    // briefly missing guard, so a corrupt registry must not block anything.
    writeFileSync(join(home, '.ion', 'worktree-registry.json'), '{ not json')
    _resetWorktreeCacheForTests()
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), MINE).block).toBe(false)
  })

  it('fails OPEN when the registry does not exist', () => {
    rmSync(join(home, '.ion', 'worktree-registry.json'))
    _resetWorktreeCacheForTests()
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), MINE).block).toBe(false)
  })

  it('ignores malformed entries without discarding the good ones', () => {
    writeFileSync(
      join(home, '.ion', 'worktree-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [
          null,
          { worktreePath: '', repoPath: REPO },
          { worktreePath: MINE },
          { worktreePath: MINE, repoPath: REPO },
        ],
      }),
    )
    _resetWorktreeCacheForTests()
    expect(gateWorktreeWrite(write(join(REPO, 'x.go')), MINE).block).toBe(true)
  })
})
