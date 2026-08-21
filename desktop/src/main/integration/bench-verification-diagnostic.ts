/**
 * Verification-failure diagnostic — rebuild the failing combination back into
 * the bench so an AI-assisted analysis conversation has something to read.
 *
 * ── The constraint this exists to satisfy ───────────────────────────────────
 * After a verification failure, `assembleBenchUnqueued` wipes the bench to an
 * empty tree (atomicity: the bench presents the enrolled combination or
 * nothing). That is correct for every OTHER purpose, but it means an agent
 * opened in the bench to analyse the failure finds an empty directory. This
 * module re-runs the same reset-and-replay sequence assembly uses, and
 * deliberately does NOT wipe on completion — the diagnostic's whole point is
 * to leave the broken tree in place, verified fresh, for the conversation to
 * read.
 *
 * ── Why this is not just "call assembleBench again" ─────────────────────────
 * A plain reassembly would replay the same poisoned recording, fail verify
 * again, and wipe the bench right back to empty — exactly the loop the
 * operator is trying to escape. This function stops one step earlier: it
 * merges everything (replaying recordings exactly like assembly does, since
 * Part A leaves them in place), then hands the result to the caller instead of
 * judging it. Whether the tree it produces still fails verify is answered
 * fresh, and the resulting evidence flows into the same
 * `lastAssemblyVerification` shape the assembly failure already uses.
 *
 * ── When it refuses ─────────────────────────────────────────────────────────
 * If a member's merge does not complete — including a genuine (non-replay)
 * conflict — this refuses rather than reporting anything: a pin has moved
 * since the failure being diagnosed, and the assembly's own conflict path is
 * the correct next step, not this one. Diagnosing a tree that can no longer
 * be reconstructed would describe a state that does not exist.
 */
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { ensureBenchWorktree, resetBenchToTree } from './bench-assemble-support'
import { resolveContribution, isLandedIntoSource } from './bench-contribution'
import { ensureRerereEnabled, tryReplayResolution } from './bench-assembly-rerere'
import { runBenchVerify } from './bench-verify'
import type { IntegrationWorkspace } from '../../shared/types'

const TAG = 'bench.verify.diagnostic'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface VerificationDiagnosticResult {
  ok: boolean
  workspace?: IntegrationWorkspace
  error?: string
}

/**
 * Rebuild the bench's failing tree and re-verify it, WITHOUT wiping on
 * completion either way. Serialized on the repo mutation queue like every
 * other bench mutation.
 */
export async function prepareVerificationDiagnostic(
  repoPath: string,
  sourceBranch: string,
  ws: IntegrationWorkspace,
): Promise<VerificationDiagnosticResult> {
  const repo = repositoryManager.get(repoPath)
  return repo.queue.enqueueMutation(async () => {
    log('preparing verification diagnostic tree', {
      repo_path: repoPath,
      source_branch: sourceBranch,
      bench_path: ws.benchPath,
    })

    try {
      await ensureBenchWorktree(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn('diagnostic: could not prepare bench worktree', { bench_path: ws.benchPath, error: msg })
      return { ok: false, error: `Could not prepare the bench worktree: ${msg}` }
    }

    await ensureRerereEnabled(ws.benchPath)

    try {
      await resetBenchToTree(ws.benchPath, ws.benchBranch, ws.sourceBranch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Could not reset the bench branch: ${msg}` }
    }

    const replayedBranches: string[] = []
    for (const member of ws.members) {
      if (!member.pinnedSha) continue
      const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
      if (contribution.empty) continue
      if (await isLandedIntoSource(ws.benchPath, member, ws.sourceBranch)) continue

      const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
      try {
        await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
      } catch {
        const replay = await tryReplayResolution(ws.benchPath, message, member.branchName, member.pinnedSha)
        if (!replay.replayed) {
          // A pin moved since the failure being diagnosed, or a recording was
          // separately forgotten. Refuse rather than describe a stale tree —
          // the situation changed, and a plain reassembly is now the correct
          // next step, not a diagnostic of a state that no longer exists.
          try { await runGit(ws.benchPath, ['merge', '--abort']) } catch { /* silent-ok: best-effort cleanup */ }
          warn('diagnostic: member no longer merges cleanly or by replay; state has changed since the failure', {
            branch: member.branchName,
            bench_path: ws.benchPath,
          })
          return {
            ok: false,
            error: `${member.branchName} no longer merges the same way it did during the failed assembly `
              + '(a pin or recording has changed). Reassemble to see the current state.',
          }
        }
        replayedBranches.push(member.branchName)
      }
    }

    const verification = await runBenchVerify(repoPath, ws.benchPath)
    const outputTail = verification.output.slice(-1200)
    log('verification diagnostic tree ready', {
      bench_path: ws.benchPath,
      replayed_branches: replayedBranches,
      verification_ran: verification.ran,
      verification_ok: verification.ok,
    })

    const diagnosed: IntegrationWorkspace = {
      ...ws,
      lastAssemblyVerification: {
        command: verification.command,
        outputTail,
        replayedBranches,
        diagnosticTreeAt: Date.now(),
      },
    }
    return { ok: true, workspace: diagnosed }
  })
}
