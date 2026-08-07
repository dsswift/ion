import { log as _log, warn as _warn } from '../logger'
import { readBenchVerify } from '../worktree/provision-manifest'
import { runProvisionCommand } from '../worktree/provision-run'

const TAG = 'bench.verify'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface BenchVerifyResult {
  ran: boolean
  ok: boolean
  output: string
  /**
   * The exact command that ran, or empty when `ran` is false (no manifest
   * declared one). Callers that surface a verification failure to the
   * operator (the bench-verification recovery dialog, the AI-assisted
   * analysis prompt) need the literal command, not a re-read of the manifest
   * at report time — the bench may already be wiped by then.
   */
  command: string
}

/**
 * Run project-declared verification against assembled bench tree.
 *
 * The manifest is read from the BENCH first, and from the source repo only as a
 * fallback. The bench tree is the assembled combination, so it is the only place
 * that describes what is actually being verified: a member whose own commits
 * introduce the `bench` block must be honoured on the assembly that contains it,
 * not ignored until that block lands on the source branch. Reading only the
 * source repo is how a poisoned recorded resolution once reached a build --
 * verification logged "project declares no command" and skipped, while the very
 * block that would have caught it sat in the assembled tree.
 *
 * The command always RUNS in the bench regardless of which manifest answered,
 * because the bench holds the tree under test.
 */
export async function runBenchVerify(repoPath: string, benchPath: string): Promise<BenchVerifyResult> {
  const benchSpec = readBenchVerify(benchPath)
  const spec = benchSpec ?? readBenchVerify(repoPath)
  // Named so the log says which manifest was authoritative. When the bench and
  // the source repo are the same directory (record-time verification passes the
  // bench for both) the bench read is the only one that happens.
  const manifestSource = benchSpec ? 'bench' : 'repo'
  if (!spec) {
    log('bench verification skipped; project declares no command', {
      repo_path: repoPath,
      bench_path: benchPath,
    })
    return { ran: false, ok: true, output: '', command: '' }
  }

  log('bench verification starting', {
    repo_path: repoPath,
    bench_path: benchPath,
    manifest_source: manifestSource,
    command: spec.verify,
    timeout_ms: spec.verifyTimeoutMs,
  })
  const result = await runProvisionCommand(spec.verify, benchPath, spec.verifyTimeoutMs)
  if (!result.ok) {
    warn('bench verification failed', {
      repo_path: repoPath,
      bench_path: benchPath,
      manifest_source: manifestSource,
      command: spec.verify,
      exit_code: result.exitCode,
      timed_out: result.timedOut ?? false,
      output_tail: result.output.slice(-1200),
      error: result.error,
    })
  } else {
    log('bench verification passed', {
      repo_path: repoPath,
      bench_path: benchPath,
      manifest_source: manifestSource,
      command: spec.verify,
    })
  }
  return { ran: true, ok: result.ok, output: result.output, command: spec.verify }
}
