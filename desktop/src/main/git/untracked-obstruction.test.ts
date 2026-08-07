import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseUntrackedObstruction, retryAfterClearingBlockingUntracked } from '../git/untracked-obstruction'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

let root: string
let repo: string

function makeRepo(): string {
  const dir = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' })
  git(dir, 'config', 'user.email', 'dev@example.com')
  git(dir, 'config', 'user.name', 'Dev')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'f.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  return dir
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-untracked-obstruction-')))
  repo = makeRepo()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parseUntrackedObstruction', () => {
  it('parses the merge shape', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '\tdesktop/src/main/worktree/sync.ts',
      '\tanother/file.txt',
      'Please move or remove them before you merge.',
      'Aborting',
    ].join('\n')
    expect(parseUntrackedObstruction(stderr)).toEqual([
      'desktop/src/main/worktree/sync.ts',
      'another/file.txt',
    ])
  })

  it('parses the rebase shape', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by rebase:',
      '\tblocked.txt',
      'Please move or remove them before you merge.',
    ].join('\n')
    expect(parseUntrackedObstruction(stderr)).toEqual(['blocked.txt'])
  })

  it('parses the checkout shape', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by checkout:',
      '\tblocked.txt',
    ].join('\n')
    expect(parseUntrackedObstruction(stderr)).toEqual(['blocked.txt'])
  })

  it('returns null for an unrelated error', () => {
    expect(parseUntrackedObstruction('CONFLICT (content): Merge conflict in f.txt')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseUntrackedObstruction('')).toBeNull()
  })
})

describe('retryAfterClearingBlockingUntracked', () => {
  it('returns the first result without retrying when the attempt succeeds', async () => {
    const outcome = await retryAfterClearingBlockingUntracked(repo, async () => 'ok')
    expect(outcome).toEqual({ result: 'ok', retried: false, removedPaths: [] })
  })

  it('rethrows an unrelated error without attempting removal', async () => {
    await expect(retryAfterClearingBlockingUntracked(repo, async () => {
      throw new Error('CONFLICT (content): Merge conflict in f.txt')
    })).rejects.toThrow('CONFLICT')
  })

  // RED before the fix: this is the exact reproduction of the confirmed
  // git behavior — an untracked file survives `rebase --abort` and blocks
  // every later operation that wants to write the same path. Real git, not a
  // mock: the behavior under test is git's own refusal-and-retry mechanics.
  it('removes exactly the git-named path and succeeds on retry', async () => {
    git(repo, 'checkout', '-qb', 'feature')
    writeFileSync(join(repo, 'blocked.txt'), 'from feature\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'feature: adds blocked.txt')
    const featureTip = git(repo, 'rev-parse', 'feature').trim()
    git(repo, 'checkout', '-q', 'main')

    // Reproduce a genuinely untracked file at the exact path the merge wants
    // to write, then let the merge fail on it precisely (real git error).
    writeFileSync(join(repo, 'blocked.txt'), 'PRE-EXISTING untracked debris\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('?? blocked.txt')

    const outcome = await retryAfterClearingBlockingUntracked(repo, () =>
      Promise.resolve(git(repo, 'merge', '--no-ff', '-m', 'merge feature', featureTip)))

    expect(outcome.retried).toBe(true)
    expect(outcome.removedPaths).toEqual(['blocked.txt'])
    expect(readFileSync(join(repo, 'blocked.txt'), 'utf-8')).toBe('from feature\n')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('')
  })

  // The precision guarantee that distinguishes this from a blind clean: an
  // UNRELATED untracked scratch file elsewhere in the tree — the operator's
  // own real content — must never be touched, even though the retry ran.
  it('never touches an untracked file git did not name as blocking', async () => {
    git(repo, 'checkout', '-qb', 'feature')
    writeFileSync(join(repo, 'blocked.txt'), 'from feature\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'feature: adds blocked.txt')
    const featureTip = git(repo, 'rev-parse', 'feature').trim()
    git(repo, 'checkout', '-q', 'main')

    writeFileSync(join(repo, 'blocked.txt'), 'PRE-EXISTING untracked debris\n')
    writeFileSync(join(repo, 'my_scratch_notes.txt'), 'operator scratch content, unrelated\n')

    await retryAfterClearingBlockingUntracked(repo, () =>
      Promise.resolve(git(repo, 'merge', '--no-ff', '-m', 'merge feature', featureTip)))

    expect(existsSync(join(repo, 'my_scratch_notes.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'my_scratch_notes.txt'), 'utf-8')).toBe('operator scratch content, unrelated\n')
  })

  it('throws the original error when nothing named can be safely removed', async () => {
    // No file exists on disk at the named path, so the untracked-verification
    // guard refuses to remove it (it is not, in fact, untracked right now).
    await expect(retryAfterClearingBlockingUntracked(repo, async () => {
      throw new Error(
        'error: The following untracked working tree files would be overwritten by merge:\n'
        + '\tnever_existed.txt\n'
        + 'Please move or remove them before you merge.',
      )
    })).rejects.toThrow('never_existed.txt')
  })
})
