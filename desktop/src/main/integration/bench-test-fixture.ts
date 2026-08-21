/**
 * Real-git bench fixture shared by bench-attribution.test.ts and
 * bench-agent-tools.test.ts.
 *
 * Ported from engine/internal/workspaces/attribution_fixture_test.go.
 * Attribution's whole value is that it answers correctly in the cases a
 * plausible-looking shortcut gets wrong: a line pushed down by an earlier
 * member, a member whose TIP touches a different file than the commit that
 * introduced the problem, two members in one file, a conflict resolution that
 * belongs to neither side. None of those are reproducible against a mocked git
 * runner — they are properties of blame, merge commits, and ancestry — so the
 * fixture assembles a real bench from real member branches.
 *
 * The layout every consumer shares:
 *
 *   main (source)      app.txt with 12 numbered lines, source_only.txt
 *     ├── wt/alpha     edits app.txt line 8; tip commit touches alpha_only.txt
 *     ├── wt/beta      inserts 5 lines at the TOP of app.txt (shifts alpha's
 *     │                edit from line 8 to line 13 in the assembly)
 *     └── wt/gamma     edits app.txt line 3 — a second owner in one file
 *   bench              base=main, merges the named members in order
 *
 * The shift is the point: alpha's line is at 8 in its own branch and 13 in the
 * bench, so an answer derived from alpha's diff coordinates names the wrong
 * line, and only blame over the assembled tree gets it right.
 *
 * The consuming test file owns the HOME redirect (vi.mock('os') with a
 * per-file env var, hoisted so it must live in the test file); this module
 * only needs the resolved ionHome path to write the records into.
 */
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

export function gitTry(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** The source file every member edits, numbered so a shifted line is visible. */
export function appLines(): string[] {
  const lines: string[] = []
  for (let i = 1; i <= 12; i++) lines.push(`line ${String(i).padStart(2, '0')}`)
  return lines
}

export function writeLines(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n')
}

export function readLinesOf(path: string): string[] {
  return readFileSync(path, 'utf-8').replace(/\n$/, '').split('\n')
}

export interface BenchFixture {
  root: string
  ionHome: string
  benchPath: string
  repo: string
  baseSha: string
  /** Member branch name to its pinned tip after buildMembers. */
  pins: Record<string, string>
}

/** Create the temp root, the Ion home, and the source repo the bench lives in. */
export function initBenchFixture(prefix: string): BenchFixture {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const ionHome = join(root, 'home')
  mkdirSync(join(ionHome, '.ion'), { recursive: true })

  const benchPath = join(root, 'integration', 'project-main')
  mkdirSync(benchPath, { recursive: true })

  git(benchPath, 'init', '-b', 'main')
  git(benchPath, 'config', 'user.email', 'dev@example.com')
  git(benchPath, 'config', 'user.name', 'Dev')
  git(benchPath, 'config', 'commit.gpgsign', 'false')
  // The fixture must not inherit the developer's global excludes. A machine
  // whose ~/.gitignore lists `*.bin` (a common ML-model entry) would silently
  // drop the binary fixture file and the binary test would fail only on that
  // machine — the exact class of machine-dependent failure a fixture exists
  // to avoid. Repository-local config, so nothing outside the temp dir moves.
  git(benchPath, 'config', 'core.excludesFile', join(root, 'empty-global-excludes'))
  // Rename detection is what the rename test asserts; repository-local so it
  // does not depend on the operator's diff config.
  git(benchPath, 'config', 'diff.renames', 'true')

  writeLines(join(benchPath, 'app.txt'), appLines())
  writeLines(join(benchPath, 'source_only.txt'), ['owned by the source branch'])
  git(benchPath, 'add', '-A')
  git(benchPath, 'commit', '-m', 'source: initial')

  return {
    root, ionHome, benchPath,
    repo: join(root, 'repo'),
    baseSha: git(benchPath, 'rev-parse', 'HEAD').trim(),
    pins: {},
  }
}

/** Create the three member branches and record their pins. */
export function buildMembers(f: BenchFixture): void {
  const app = join(f.benchPath, 'app.txt')

  // alpha: edits line 8, then a tip commit that touches a DIFFERENT file.
  // The tip-only shortcut fails here — the tip does not touch app.txt at all.
  git(f.benchPath, 'switch', '-c', 'wt/alpha', f.baseSha)
  let lines = readLinesOf(app)
  lines[7] = 'line 08 changed by alpha'
  writeLines(app, lines)
  git(f.benchPath, 'add', '-A')
  git(f.benchPath, 'commit', '-m', 'alpha: edit line 8')
  writeLines(join(f.benchPath, 'alpha_only.txt'), ['alpha'])
  git(f.benchPath, 'add', '-A')
  git(f.benchPath, 'commit', '-m', 'alpha: tip touches only alpha_only.txt')
  f.pins['wt/alpha'] = git(f.benchPath, 'rev-parse', 'HEAD').trim()

  // beta: inserts 5 lines at the TOP, shifting every later line down by 5.
  git(f.benchPath, 'switch', '-c', 'wt/beta', f.baseSha)
  lines = readLinesOf(app)
  writeLines(app, ['beta header 1', 'beta header 2', 'beta header 3', 'beta header 4', 'beta header 5', ...lines])
  git(f.benchPath, 'add', '-A')
  git(f.benchPath, 'commit', '-m', 'beta: insert 5 header lines')
  f.pins['wt/beta'] = git(f.benchPath, 'rev-parse', 'HEAD').trim()

  // gamma: edits line 3 — a second owner inside one file, far from alpha's.
  git(f.benchPath, 'switch', '-c', 'wt/gamma', f.baseSha)
  lines = readLinesOf(app)
  lines[2] = 'line 03 changed by gamma'
  writeLines(app, lines)
  git(f.benchPath, 'add', '-A')
  git(f.benchPath, 'commit', '-m', 'gamma: edit line 3')
  f.pins['wt/gamma'] = git(f.benchPath, 'rev-parse', 'HEAD').trim()

  git(f.benchPath, 'switch', 'main')
}

/** Member record with the full shape the desktop's normalizer expects. */
export function memberRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    pin: 'current', merge: 'merged',
    pinnedTreeHash: '', currentTreeHash: '', pinnedBaseSha: '',
    ...over,
  }
}

/** Write the integration-workspaces record the desktop's loader reads. */
export function writeRecord(
  f: BenchFixture, members: Record<string, unknown>[], extra?: Record<string, unknown>,
): void {
  const workspace: Record<string, unknown> = {
    repoPath: f.repo,
    sourceBranch: 'main',
    benchPath: f.benchPath,
    benchBranch: 'ion/bench/main',
    baseSha: f.baseSha,
    lastAssembly: 'assembled',
    lastBuiltAt: 1,
    members,
    ...extra,
  }
  writeFileSync(
    join(f.ionHome, '.ion', 'integration-workspaces.json'),
    JSON.stringify({ version: 1, workspaces: [workspace] }),
  )
}

/**
 * Build the bench branch by merging each named member in order, and write the
 * workspace record with those pins. Mirrors what the real assembly does: base
 * first, then each member's pinned tip.
 */
export function assemble(f: BenchFixture, ...branches: string[]): void {
  git(f.benchPath, 'switch', '-C', 'ion/bench/main', f.baseSha)
  for (const branch of branches) {
    git(f.benchPath, 'merge', '--no-ff', '-m', `assembly: merge ${branch}`, f.pins[branch])
  }
  writeRecord(f, branches.map((branch) => memberRecord({
    worktreePath: '/wt/' + branch.replace(/^wt\//, ''),
    branchName: branch,
    pinnedSha: f.pins[branch],
    pinnedBaseSha: f.baseSha,
  })))
}

/** Seed the worktree registry so titles and non-member worktrees exist. */
export function writeWorktreeEntries(f: BenchFixture, entries: Record<string, unknown>[]): void {
  writeFileSync(
    join(f.ionHome, '.ion', 'worktree-registry.json'),
    JSON.stringify({ version: 1, entries }),
  )
}

/** Seed the resolution journal in the fixture's Ion home. */
export function writeResolutions(f: BenchFixture, entries: Record<string, unknown>[]): void {
  writeFileSync(
    join(f.ionHome, '.ion', 'integration-resolutions.json'),
    JSON.stringify({ version: 1, entries }),
  )
}

/**
 * The 1-based line number in the assembled bench file whose content matches
 * want. Tests locate lines by CONTENT, never by a hardcoded number: a
 * hardcoded number would silently start asserting about the wrong line the
 * moment the fixture's shape changed, which is the exact defect attribution
 * exists to prevent.
 */
export function lineOf(f: BenchFixture, relPath: string, want: string): number {
  const lines = readLinesOf(join(f.benchPath, relPath))
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(want)) return i + 1
  }
  throw new Error(`no line containing "${want}" in the assembled ${relPath}: ${JSON.stringify(lines)}`)
}
