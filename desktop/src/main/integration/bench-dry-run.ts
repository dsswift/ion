/**
 * Pin-update collision dry-run — "will the NEXT assembly fail?"
 *
 * Split from bench-ops.ts (file-size cap): this is the warn-early half of the
 * atomic-assembly design. bench-ops' Update verbs call `dryRunCollision`
 * before persisting a new pin and attach the returned warning to their result.
 */
import { runGit } from '../git-runner'
import { mergeTree } from './merge-tree'
import { log as _log } from '../logger'
import type { IntegrationWorkspace } from '../../shared/types'

const TAG = 'bench.dryrun'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Dry-run one member's merge against a simulated bench and name the collision.
 *
 * `git merge-tree --write-tree` performs a real merge in memory — no checkout,
 * no index, no working tree. `merge-tree.ts` parses its machine-readable
 * `--name-only -z` conflicted-file section rather than unstable human messages.
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
  try {
    // Simulated base: source tip plus every OTHER enabled member, merged in
    // order via merge-tree chaining. A prior member that itself conflicts with
    // the simulation is skipped — the dry-run answers for THIS update, and the
    // assembly will report the other collision on its own.
    let simulated = (await runGit(ws.repoPath, ['rev-parse', ws.sourceBranch])).trim()
    for (const m of ws.members) {
      if (!m.enabled || !m.pinnedSha || m.worktreePath === candidate.worktreePath) continue
      const prior = await mergeTree(ws.repoPath, simulated, m.pinnedSha)
      if (prior.prediction !== 'clean' || !prior.tree) continue
      // Advance the simulation as a synthetic commit so later members merge
      // onto the combination, exactly like the real assembly does.
      const tree = prior.tree
      simulated = (await runGit(ws.repoPath, [
        'commit-tree', tree, '-p', simulated, '-p', m.pinnedSha, '-m', 'ion-bench: dry-run',
      ])).trim()
    }

    const probe = await mergeTree(ws.repoPath, simulated, candidate.sha)
    if (probe.prediction !== 'conflict') return undefined

    // `merge-tree --name-only -z` supplies machine-readable conflicted paths.
    // Human CONFLICT messages are intentionally not parsed: Git declares them
    // unstable and they cannot accurately represent every conflict shape.
    const files = probe.conflictPaths
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
