/**
 * Resolves the FR-04 credential env a session's `EngineConfig.toolEnv`
 * should carry for its working directory, so the AGENT's own `git push`
 * (executed inside the engine, via Bash) authenticates as the tab's
 * principal -- not just the SERVER's own git operations, which
 * `git-runner.ts`'s `principalGitEnv` already covers.
 *
 * A session's working directory has one git remote host for its whole
 * lifetime (the common case), resolved once at `start_session` the same way
 * `remoteForGitInvocation` resolves it for a live `runGit` call -- defaulting
 * to `origin`, the subcommand ('push') is a placeholder that never actually
 * runs; it only steers which operand `remoteForGitInvocation` treats as a
 * remote name vs a URL.
 */
import { remoteForGitInvocation } from './remote-host'
import { resolveGitCredential } from './resolver'
import { materializeGitCredential } from './materialize'
import { warn as _warn } from '../../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('git-identity-workspace-tool-env', msg, fields)
}

/** Returns the additive env to merge into `EngineConfig.toolEnv`, or undefined when there is nothing to add (no working directory, no subject, no configured remote, or no resolvable credential). */
export async function resolveWorkspaceGitToolEnv(workingDirectory: string | undefined, subject: string | undefined): Promise<Record<string, string> | undefined> {
  if (!workingDirectory || !subject) return undefined
  try {
    const remote = await remoteForGitInvocation(workingDirectory, ['push'])
    if (!remote) return undefined
    const cred = await resolveGitCredential(subject, remote.host, { transport: remote.transport })
    if (!cred) return undefined
    return await materializeGitCredential(subject, cred)
  } catch (err) {
    warn('resolving workspace git credential failed; starting the session without one', { subject, working_directory: workingDirectory, error: String(err) })
    return undefined
  }
}
