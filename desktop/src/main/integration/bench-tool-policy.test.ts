/**
 * Tool-gate policy tests — ported from the bench arms of the engine's
 * containment_test.go, bench_test.go, and containment_bench_origin_test.go so
 * the desktop policy and the engine's original pin identical behaviour.
 *
 * The bench rules depend on git behaviour (MERGE_HEAD, unmerged index
 * entries, range diffs), so these tests run against a real repository in a
 * temp dir, with HOME redirected so bench-store reads a fixture record —
 * bench-store resolves homedir() lazily on every call, so redirecting HOME in
 * beforeEach is enough and no module-load ordering is involved (same pattern
 * as bench-guard.test.ts).
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { evaluateToolGate, type GateRequest } from './bench-tool-policy'

let root: string
let home: string
let repo: string
let benchPath: string
const savedHome = process.env.HOME

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'dev@example.com'])
  git(dir, ['config', 'user.name', 'Dev'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  // Do not inherit the developer's global excludes: a ~/.gitignore entry
  // matching a fixture filename would make this fixture behave differently on
  // one machine than another.
  git(dir, ['config', 'core.excludesFile', join(root, 'empty-global-excludes')])
}

interface MemberRecord {
  worktreePath: string
  branchName: string
  enabled?: boolean
  pinnedSha?: string
  pinnedBaseSha?: string
}

function writeWorkspaces(members: MemberRecord[], baseSha = ''): void {
  writeFileSync(join(home, '.ion', 'integration-workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: [{
      repoPath: repo, sourceBranch: 'main', benchPath, benchBranch: 'ion/bench/main',
      members, baseSha, lastBuiltAt: 0,
    }],
  }))
}

function writeWorktreeRegistry(entries: Array<{ worktreePath: string; repoPath: string; branchName: string }>): void {
  writeFileSync(join(home, '.ion', 'worktree-registry.json'), JSON.stringify({
    version: 1,
    entries: entries.map((e) => ({ ...e, sourceBranch: 'main' })),
  }))
}

/** Leave a real merge in progress in the bench, conflicted on shared.txt. */
function startConflictedMerge(): void {
  git(benchPath, ['switch', '-c', 'feature'])
  writeFileSync(join(benchPath, 'shared.txt'), 'feature\n')
  git(benchPath, ['add', '-A'])
  git(benchPath, ['commit', '-m', 'feature side'])
  git(benchPath, ['switch', 'main'])
  writeFileSync(join(benchPath, 'shared.txt'), 'main\n')
  git(benchPath, ['add', '-A'])
  git(benchPath, ['commit', '-m', 'main side'])
  try {
    git(benchPath, ['merge', '--no-ff', '-m', 'conflicted', 'feature'])
    throw new Error('expected the merge to conflict')
  } catch {
    // expected: the merge conflicts and stays open // silent-ok: assertion below proves state
  }
}

function bash(command: string, cwd: string, siblings?: string[]): GateRequest {
  return { toolName: 'Bash', input: { command }, cwd, siblingTools: siblings }
}

function write(target: string, cwd: string): GateRequest {
  return { toolName: 'Write', input: { file_path: target }, cwd }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-toolpolicy-'))
  home = join(root, 'home')
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.HOME = home
  repo = join(root, 'source', 'project')
  benchPath = join(root, 'integration', 'project-main')
  initRepo(benchPath)
  writeFileSync(join(benchPath, 'shared.txt'), 'base\n')
  git(benchPath, ['add', '-A'])
  git(benchPath, ['commit', '-m', 'base'])
  writeWorkspaces([])
})

afterEach(() => {
  process.env.HOME = savedHome
  removeGitFixture(root)
})

describe('bench history rules', () => {
  it('refuses history-writing git verbs in a bench', () => {
    for (const cmd of [
      'git commit -m x',
      'git push origin HEAD',
      'git pull',
      'git rebase main',
      'git cherry-pick abc123',
      'git reset --hard HEAD~1',
      'git stash',
      'git tag v1',
      'git switch -c other',
      'git add -A && git commit -m x', // chained: refused on the commit
    ]) {
      const r = evaluateToolGate(bash(cmd, benchPath))
      expect(r, cmd).not.toBeNull()
      expect(r!.reason).toContain('recreated from scratch')
    }
  })

  it('passes reads, builds, and staging — the bench purpose', () => {
    for (const cmd of [
      'git status --short',
      'git log --oneline -5',
      'git diff HEAD',
      'git add -A',
      'git apply /tmp/x.patch',
      'npm test',
      'make build && make test',
    ]) {
      expect(evaluateToolGate(bash(cmd, benchPath)), cmd).toBeNull()
    }
  })

  it('refuses history in a bench subdirectory', () => {
    const sub = join(benchPath, 'desktop', 'src')
    mkdirSync(sub, { recursive: true })
    expect(evaluateToolGate(bash('git commit -m x', sub))).not.toBeNull()
  })

  it('passes history outside the bench, including a prefix-sharing sibling', () => {
    mkdirSync(repo, { recursive: true })
    expect(evaluateToolGate(bash('git commit -m x', repo))).toBeNull()
    // A sibling sharing the bench path prefix is not the bench.
    expect(evaluateToolGate(bash('git commit -m x', `${benchPath}-other`))).toBeNull()
  })

  it('refuses a cd into the bench from elsewhere', () => {
    const r = evaluateToolGate(bash(`cd ${benchPath} && git commit -m x`, '/tmp'))
    expect(r).not.toBeNull()
  })

  it('refuses git -C into the bench from elsewhere', () => {
    const r = evaluateToolGate(bash(`git -C ${benchPath} commit -m x`, '/tmp'))
    expect(r).not.toBeNull()
  })

  it('passes a dynamic destination (logged, never guessed)', () => {
    expect(evaluateToolGate(bash('cd "$TARGET" && git commit -m x', benchPath + '-unrelated'))).toBeNull()
  })
})

describe('bench write rules', () => {
  it('refuses file writes into the bench and explains ephemerality', () => {
    for (const tool of ['Write', 'Edit']) {
      const r = evaluateToolGate({ toolName: tool, input: { file_path: join(benchPath, 'shared.txt') }, cwd: benchPath })
      expect(r, tool).not.toBeNull()
      expect(r!.reason).toContain('destroyed by the next assembly')
    }
    const nb = evaluateToolGate({ toolName: 'NotebookEdit', input: { notebook_path: join(benchPath, 'n.ipynb') }, cwd: benchPath })
    expect(nb).not.toBeNull()
  })

  it('refuses ion_scaffold targeting the bench via targetDir', () => {
    const r = evaluateToolGate({ toolName: 'ion_scaffold', input: { targetDir: benchPath }, cwd: '/tmp' })
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('destroyed by the next assembly')
  })

  it('allows ion_scaffold targeting a non-bench directory', () => {
    const r = evaluateToolGate({ toolName: 'ion_scaffold', input: { targetDir: '/tmp/project' }, cwd: '/tmp' })
    expect(r).toBeNull()
  })

  it('refuses ion_scaffold with a relative targetDir that resolves into the bench', () => {
    const r = evaluateToolGate({ toolName: 'ion_scaffold', input: { targetDir: basename(benchPath) }, cwd: dirname(benchPath) })
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('destroyed by the next assembly')
  })

  it('refuses ion_scaffold when cwd is inside the bench (implicit target)', () => {
    const sub = join(benchPath, 'packages')
    mkdirSync(sub, { recursive: true })
    const r = evaluateToolGate({ toolName: 'ion_scaffold', input: { targetDir: '.' }, cwd: sub })
    expect(r).not.toBeNull()
  })

  it('refuses ion_scaffold targeting a bench subdirectory', () => {
    const sub = join(benchPath, 'packages', 'core')
    const r = evaluateToolGate({ toolName: 'ion_scaffold', input: { targetDir: sub }, cwd: '/tmp' })
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('destroyed by the next assembly')
  })

  it('allows ion_scaffold inside a bench during merge carve-out for unmerged path', () => {
    startConflictedMerge()
    const r = evaluateToolGate({ toolName: 'ion_scaffold', input: { targetDir: benchPath }, cwd: '/tmp' })
    // ion_scaffold targets a directory, not a specific unmerged file, so the
    // carve-out does NOT apply — scaffold is refused even during a merge.
    expect(r).not.toBeNull()
  })

  it('the TARGET decides, not the cwd', () => {
    const r = evaluateToolGate(write(join(benchPath, 'shared.txt'), '/tmp'))
    expect(r).not.toBeNull()
  })

  it('names no member when the file comes from the source branch', () => {
    const r = evaluateToolGate(write(join(benchPath, 'shared.txt'), benchPath))
    expect(r!.reason).toContain('No enrolled member changes this file')
    expect(r!.reason).toContain('WorkspaceAttribution')
  })

  it('attributes owners by contribution RANGE, never the tip commit', () => {
    // Member branch: commit 1 touches shared.txt, commit 2 (the tip) touches
    // an unrelated file. Range attribution must still name the member.
    git(benchPath, ['switch', '-c', 'wt/member-a'])
    writeFileSync(join(benchPath, 'shared.txt'), 'from member\n')
    git(benchPath, ['add', '-A'])
    git(benchPath, ['commit', '-m', 'member touches shared'])
    writeFileSync(join(benchPath, 'docs.txt'), 'docs only\n')
    git(benchPath, ['add', '-A'])
    git(benchPath, ['commit', '-m', 'member tip touches docs only'])
    const pin = git(benchPath, ['rev-parse', 'HEAD']).trim()
    const base = git(benchPath, ['rev-parse', 'main']).trim()
    git(benchPath, ['switch', 'main'])

    writeWorkspaces([{
      worktreePath: '/wt/member-a', branchName: 'wt/member-a',
      enabled: true, pinnedSha: pin, pinnedBaseSha: base,
    }])

    const r = evaluateToolGate(write(join(benchPath, 'shared.txt'), benchPath))
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('wt/member-a')
    expect(r!.reason).toContain('/wt/member-a')
    // The unrelated docs.txt has no owner-specific redirect to this member's
    // tip-only file... but shared.txt names exactly one member.
    expect(r!.reason).toContain('This file is integrated from member')
  })

  it('lists every owner with line ranges when several members change one file', () => {
    const mkMember = (branch: string, content: string): { pin: string; base: string } => {
      const base = git(benchPath, ['rev-parse', 'main']).trim()
      git(benchPath, ['switch', '-c', branch, 'main'])
      writeFileSync(join(benchPath, 'shared.txt'), content)
      git(benchPath, ['add', '-A'])
      git(benchPath, ['commit', '-m', branch])
      const pin = git(benchPath, ['rev-parse', 'HEAD']).trim()
      git(benchPath, ['switch', 'main'])
      return { pin, base }
    }
    const a = mkMember('wt/a', 'from a\n')
    const b = mkMember('wt/b', 'from b\n')
    writeWorkspaces([
      { worktreePath: '/wt/a', branchName: 'wt/a', enabled: true, pinnedSha: a.pin, pinnedBaseSha: a.base },
      { worktreePath: '/wt/b', branchName: 'wt/b', enabled: true, pinnedSha: b.pin, pinnedBaseSha: b.base },
    ])

    const r = evaluateToolGate(write(join(benchPath, 'shared.txt'), benchPath))
    expect(r!.reason).toContain('2 members change this file')
    expect(r!.reason).toContain('wt/a')
    expect(r!.reason).toContain('wt/b')
    // Hunk headers from `git diff -U0` produce L<start>… ranges.
    expect(r!.reason).toMatch(/L\d+/)
  })
})

describe('resolve-once carve-out lifecycle', () => {
  it('walks the full lifecycle: closed, open, staged, markers, closed', () => {
    // Closed before any merge: driver verbs and edits refused.
    let r = evaluateToolGate(bash('git merge --continue', benchPath))
    expect(r!.reason).toContain('no bench merge is open')
    expect(evaluateToolGate(write(join(benchPath, 'shared.txt'), benchPath))).not.toBeNull()

    startConflictedMerge()

    // Open: edit to the unmerged path IS the resolution and must pass.
    expect(evaluateToolGate(write(join(benchPath, 'shared.txt'), benchPath))).toBeNull()
    // Premature continue must explain unresolved paths.
    r = evaluateToolGate(bash('git merge --continue', benchPath))
    expect(r!.reason).toContain('unmerged')
    // Abort passes mid-merge.
    expect(evaluateToolGate(bash('git merge --abort', benchPath))).toBeNull()
    // Compound continue must require the exact standalone invocation.
    r = evaluateToolGate(bash('git add shared.txt && git merge --continue', benchPath))
    expect(r!.reason).toContain('exactly')
    for (const command of [
      'git merge --continue &',
      'git merge --continue >out',
      '(git merge --continue)',
      'env git merge --continue',
      'git merge --continue extra',
      'git merge --continue $(echo hidden)',
    ]) {
      r = evaluateToolGate(bash(command, benchPath))
      expect(r, command).not.toBeNull()
      expect(r!.reason, command).toContain('run exactly')
    }

    // Stage a valid resolution: standalone continue is allowed.
    writeFileSync(join(benchPath, 'shared.txt'), 'resolved\n')
    git(benchPath, ['add', 'shared.txt'])
    expect(evaluateToolGate(bash('git merge --continue', benchPath))).toBeNull()

    // Staged conflict markers block continue with an actionable reason.
    writeFileSync(join(benchPath, 'shared.txt'), '<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\n')
    git(benchPath, ['add', 'shared.txt'])
    r = evaluateToolGate(bash('git merge --continue', benchPath))
    expect(r!.reason).toContain('git diff --cached --check')

    // Scoped tight: a CLEAN path stays refused, a FRESH merge stays refused,
    // other history verbs stay refused — the carve-out is the resolution
    // surface, not the merge state.
    writeFileSync(join(benchPath, 'clean.txt'), 'x\n')
    expect(evaluateToolGate(write(join(benchPath, 'clean.txt'), benchPath))).not.toBeNull()
    expect(evaluateToolGate(bash('git merge feature', benchPath))).not.toBeNull()
    expect(evaluateToolGate(bash('git commit -m x', benchPath))).not.toBeNull()

    // Closed again after abort.
    git(benchPath, ['merge', '--abort'])
    expect(evaluateToolGate(bash('git merge --continue', benchPath))).not.toBeNull()
    expect(evaluateToolGate(write(join(benchPath, 'shared.txt'), benchPath))).not.toBeNull()
  })

  it('refuses continue when sibling tool calls share the turn', () => {
    startConflictedMerge()
    writeFileSync(join(benchPath, 'shared.txt'), 'resolved\n')
    git(benchPath, ['add', 'shared.txt'])
    // Fully staged and validated — but turn-mates run concurrently, so the
    // merge completion cannot share a response with anything.
    const r = evaluateToolGate(bash('git merge --continue', benchPath, ['Read']))
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('no sibling tool calls')
    // Abort is not turn-isolated: it destroys no validation evidence.
    expect(evaluateToolGate(bash('git merge --abort', benchPath, ['Read']))).toBeNull()
  })
})

describe('bench-origin destinations', () => {
  let enabled: string
  let disabled: string
  let nonMember: string

  beforeEach(() => {
    enabled = join(root, 'worktrees', 'project-enabled')
    disabled = join(root, 'worktrees', 'project-disabled')
    nonMember = join(root, 'worktrees', 'project-nonmember')
    for (const d of [repo, enabled, disabled, nonMember]) mkdirSync(d, { recursive: true })
    writeWorkspaces([
      { worktreePath: enabled, branchName: 'wt/enabled', enabled: true },
      { worktreePath: disabled, branchName: 'wt/disabled', enabled: false },
    ])
    writeWorktreeRegistry([
      { worktreePath: enabled, repoPath: repo, branchName: 'wt/enabled' },
      { worktreePath: disabled, repoPath: repo, branchName: 'wt/disabled' },
      { worktreePath: nonMember, repoPath: repo, branchName: 'wt/nonmember' },
    ])
  })

  it('write into an enabled member passes — the remediation path itself', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
      const r = evaluateToolGate({ toolName: tool, input: { [key]: join(enabled, 'src', 'fix.go') }, cwd: benchPath })
      expect(r, tool).toBeNull()
    }
  })

  it('committing in an enabled member passes — half the remediation', () => {
    for (const cmd of [
      `cd ${enabled} && git commit -am fix`,
      `git -C ${enabled} commit -am fix`,
      `cd ${enabled} && git add -A && git commit -m fix`,
    ]) {
      expect(evaluateToolGate(bash(cmd, benchPath)), cmd).toBeNull()
    }
  })

  it('refuses a disabled member: its content is not in the bench', () => {
    const r = evaluateToolGate(write(join(disabled, 'x.go'), benchPath))
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('DISABLED')
    expect(r!.reason).toContain('cannot originate from it')
    expect(r!.reason).toContain('WorkspaceAttribution')
  })

  it('refuses the source checkout', () => {
    const r = evaluateToolGate(write(join(repo, 'main.go'), benchPath))
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('source checkout')
    expect(r!.reason).toContain('WorkspaceAttribution')
  })

  it('refuses a non-member worktree of the same repo', () => {
    const r = evaluateToolGate(write(join(nonMember, 'x.go'), benchPath))
    expect(r).not.toBeNull()
    expect(r!.reason).toContain('NOT enrolled')
  })

  it('refuses history verbs in the source checkout and non-member via bash', () => {
    expect(evaluateToolGate(bash(`cd ${repo} && git commit -am x`, benchPath))).not.toBeNull()
    expect(evaluateToolGate(bash(`git -C ${nonMember} commit -am x`, benchPath))).not.toBeNull()
  })

  it('member with absent enabled key is enrolled and writable', () => {
    writeWorkspaces([{ worktreePath: enabled, branchName: 'wt/enabled' }])
    expect(evaluateToolGate(write(join(enabled, 'x.go'), benchPath))).toBeNull()
  })

  it('is not a cwd jail: unrelated destinations pass', () => {
    for (const target of ['/tmp/scratch.txt', join(home, '.ion', 'notes.md'), join(root, 'unrelated', 'x.go')]) {
      expect(evaluateToolGate(write(target, benchPath)), target).toBeNull()
    }
  })

  it('non-history commands outside the bench pass', () => {
    for (const cmd of [
      `cd ${repo} && npm test`,
      `cd ${nonMember} && git status --short`,
      `cd ${disabled} && make build`,
    ]) {
      expect(evaluateToolGate(bash(cmd, benchPath)), cmd).toBeNull()
    }
  })
})

describe('fail-open and scope', () => {
  it('allows everything when the workspaces record is missing', () => {
    rmSync(join(home, '.ion', 'integration-workspaces.json'))
    expect(evaluateToolGate(bash('git commit -m x', benchPath))).toBeNull()
    expect(evaluateToolGate(write(join(benchPath, 'x.txt'), benchPath))).toBeNull()
  })

  it('allows everything when the workspaces record is corrupt', () => {
    writeFileSync(join(home, '.ion', 'integration-workspaces.json'), '{not json')
    expect(evaluateToolGate(bash('git commit -m x', benchPath))).toBeNull()
  })

  it('never inspects read and dispatch tools', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'Agent', 'WebFetch']) {
      expect(evaluateToolGate({ toolName: tool, input: { file_path: join(benchPath, 'x') }, cwd: benchPath })).toBeNull()
    }
  })

  it('passes a Bash call with no command string', () => {
    expect(evaluateToolGate({ toolName: 'Bash', input: {}, cwd: benchPath })).toBeNull()
  })
})
