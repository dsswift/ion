/**
 * Pin-update collision dry-run — "will the NEXT assembly fail?"
 *
 * Split from bench-ops.ts (file-size cap): this is the warn-early half of the
 * atomic-assembly design. bench-ops' Update verbs call `dryRunCollision`
 * before persisting a new pin and attach the returned warning to their result.
 */
import { runGit, gitExec } from '../git-runner'
import { log as _log } from '../logger'
import type { IntegrationWorkspace } from '../../shared/types'

const TAG = 'bench.dryrun'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Dry-run one member's merge against a simulated bench and name the collision.
 *
 * `git merge-tree --write-tree` performs a real merge in memory — no checkout,
 * no index, no working tree — and exits non-zero with a `CONFLICT` report on
 * STDOUT when the trees collide (which is why this calls `gitExec` directly:
 * `runGit` surfaces stderr only, and the report would be lost). Run at
 * pin-advance time it answers "will the NEXT assembly fail?" BEFORE the
 * operator's bench goes empty. The answer is a WARNING, never a gate:
 * overlapping in-flight work is the bench's most valuable case, so the update
 * always proceeds and the operator decides whether to resolve now or keep
 * working.
 *
 * The simulation merges the candidate pin onto the CURRENT source tip with the
 * other enabled members' pins applied in order — the same inputs the next
 * assembly will use. Best-effort: any probe failure (other than a predicted
 * conflict) returns no warning, since a broken dry-run must never block or
 * mislabel an update.
 */
export async function dryRunCollision(
  ws: IntegrationWorkspace,
  candidate: { worktreePath: string; branchName: string; sha: string },
): Promise<string | undefined> {
  const mergeTree = async (a: string, b: string): Promise<{ ok: boolean; stdout: string }> => {
    try {
      const { stdout } = await gitExec('git', ['merge-tree', '--write-tree', a, b], {
        cwd: ws.repoPath, maxBuffer: 10 * 1024 * 1024,
      })
      return { ok: true, stdout }
    } catch (err) {
      const e = err as { code?: number; stdout?: string }
      // Exit 1 = conflicted merge, report on stdout. Anything else is a probe
      // failure and is rethrown to the outer best-effort catch.
      if (e.code === 1) return { ok: false, stdout: e.stdout ?? '' }
      throw err
    }
  }

  try {
    // Simulated base: source tip plus every OTHER enabled member, merged in
    // order via merge-tree chaining. A prior member that itself conflicts with
    // the simulation is skipped — the dry-run answers for THIS update, and the
    // assembly will report the other collision on its own.
    let simulated = (await runGit(ws.repoPath, ['rev-parse', ws.sourceBranch])).trim()
    for (const m of ws.members) {
      if (!m.enabled || !m.pinnedSha || m.worktreePath === candidate.worktreePath) continue
      const prior = await mergeTree(simulated, m.pinnedSha)
      if (!prior.ok) continue
      // Advance the simulation as a synthetic commit so later members merge
      // onto the combination, exactly like the real assembly does.
      const tree = prior.stdout.trim().split('\n')[0]
      simulated = (await runGit(ws.repoPath, [
        'commit-tree', tree, '-p', simulated, '-p', m.pinnedSha, '-m', 'ion-bench: dry-run',
      ])).trim()
    }

    const probe = await mergeTree(simulated, candidate.sha)
    if (probe.ok) return undefined

    // Predicted conflict. The report lists one `CONFLICT (…): …` line per
    // collision; the file names in it are what makes the warning actionable.
    const files = [...new Set(
      probe.stdout.split('\n')
        .filter((l) => l.startsWith('CONFLICT'))
        .map((l) => l.replace(/^CONFLICT \([^)]*\):\s*/, '').split(' ')[0])
        .filter(Boolean),
    )]
    log('pin update dry-run predicts a conflict', {
      branch: candidate.branchName,
      files: files.join(','),
    })
    return files.length > 0
      ? `Updating ${candidate.branchName} will conflict on ${files.join(', ')} at the next assembly.`
      : `Updating ${candidate.branchName} will conflict at the next assembly.`
  } catch (err) {
    log('pin update dry-run unavailable', { branch: candidate.branchName, error: String(err) })
    return undefined
  }
}
