/**
 * Bench briefing tests — the proactive system-prompt addition for bench
 * conversations.
 *
 * ── The behavior these pin ──────────────────────────────────────────────────
 * A live bench conversation had to be hand-held twice: once to learn it was in
 * a bench built from member worktrees, once more to redirect a finished plan's
 * edits out of the bench. The briefing exists so both facts are in the system
 * prompt at turn one. Pinned here:
 *   - inside a bench: the briefing names the bench path, the source branch,
 *     every enabled member (label + worktree path), the no-edits rule, the
 *     member-worktree routing rule, and both bench tools;
 *   - a disabled member is excluded (it is not in the current build, so
 *     routing an edit to it would integrate work the operator excluded);
 *   - outside a bench: null (the persona is injected alone);
 *   - fail-open: a corrupt or missing workspace file yields null, never a
 *     throw — the write gate still stands behind the missing briefing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => process.env.ION_BB_TEST_HOME || actual.homedir() }
})

import { buildBenchBriefing } from '../../../../engine/extensions/ion-meta/bench-briefing'
import { _resetBenchWriteCacheForTests } from '../../../../engine/extensions/ion-meta/bench-write-gate'

let root: string
let bench: string

function writeWorkspaces(payload: unknown): void {
  writeFileSync(join(home, '.ion', 'integration-workspaces.json'),
    typeof payload === 'string' ? payload : JSON.stringify(payload))
  _resetBenchWriteCacheForTests()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-bb-'))
  home = join(root, 'home')
  bench = join(root, 'integration', 'proj-main')
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_BB_TEST_HOME = home
})

afterEach(() => {
  delete process.env.ION_BB_TEST_HOME
  rmSync(root, { recursive: true, force: true })
  _resetBenchWriteCacheForTests()
})

const WT_A = '/wt/proj-alpha'
const WT_B = '/wt/proj-beta'

function workspace(): unknown {
  return {
    version: 1,
    workspaces: [{
      repoPath: '/repo/proj',
      sourceBranch: 'main',
      benchPath: bench,
      benchBranch: 'ion/bench/main',
      baseSha: 'aaaabbbbccccdddd',
      lastBuiltAt: 1,
      members: [
        { worktreePath: WT_A, branchName: 'wt/alpha', label: 'alpha', enabled: true, pinnedSha: '1111222233334444' },
        { worktreePath: WT_B, branchName: 'wt/beta', label: 'beta', enabled: false, pinnedSha: '5555666677778888' },
      ],
    }],
  }
}

describe('buildBenchBriefing — inside a bench', () => {
  it('names the bench, the source branch, and the rules', () => {
    writeWorkspaces(workspace())

    const briefing = buildBenchBriefing(bench)

    expect(briefing).not.toBeNull()
    expect(briefing).toContain(bench)
    expect(briefing).toContain('main')
    expect(briefing).toContain('INTEGRATION BENCH')
    // The one hard rule, and where edits belong instead.
    expect(briefing).toContain('Never plan or make edits inside the bench')
    expect(briefing).toContain('member worktree that owns the file')
    // The plan-mode corollary — the live incident's second intervention.
    expect(briefing).toContain('plan that edits bench paths is wrong')
    // Both tools are named so the model knows the routing surface exists.
    expect(briefing).toContain('ion_bench_locate')
    expect(briefing).toContain('ion_bench_info')
  })

  it('lists enabled members with their worktree paths, and excludes disabled ones', () => {
    writeWorkspaces(workspace())

    const briefing = buildBenchBriefing(bench)!

    expect(briefing).toContain('alpha')
    expect(briefing).toContain(WT_A)
    expect(briefing).toContain('wt/alpha')
    expect(briefing).toContain('1111222') // pinned sha, shortened
    // beta is disabled: not part of the current build, so routing an edit to
    // it from the briefing would integrate work the operator excluded.
    expect(briefing).not.toContain(WT_B)
    expect(briefing).not.toContain('wt/beta')
  })

  it('works from a SUBDIRECTORY of the bench', () => {
    // Conversations rarely sit at the bench root; containment must be
    // prefix-based exactly like the gates.
    writeWorkspaces(workspace())
    expect(buildBenchBriefing(join(bench, 'desktop', 'src'))).not.toBeNull()
  })

  it('says so when the bench has no enabled members', () => {
    const ws = workspace() as { workspaces: Array<{ members: unknown[] }> }
    ws.workspaces[0].members = []
    writeWorkspaces(ws)
    const briefing = buildBenchBriefing(bench)!
    expect(briefing).toContain('no enabled members')
  })
})

describe('buildBenchBriefing — outside a bench', () => {
  it('returns null for an ordinary directory', () => {
    writeWorkspaces(workspace())
    expect(buildBenchBriefing('/some/ordinary/project')).toBeNull()
  })

  it('returns null for a prefix-sharing sibling of the bench', () => {
    // `…/proj-main-other` must not read as inside `…/proj-main` — the same
    // exact-or-separator rule every bench/worktree guard uses.
    writeWorkspaces(workspace())
    expect(buildBenchBriefing(`${bench}-other`)).toBeNull()
  })

  it('returns null for an empty cwd', () => {
    writeWorkspaces(workspace())
    expect(buildBenchBriefing('')).toBeNull()
  })
})

describe('buildBenchBriefing — fail-open', () => {
  it('returns null when the workspace file does not exist', () => {
    _resetBenchWriteCacheForTests()
    expect(buildBenchBriefing(bench)).toBeNull()
  })

  it('returns null when the workspace file is corrupt', () => {
    writeWorkspaces('{ not json')
    expect(buildBenchBriefing(bench)).toBeNull()
  })
})
