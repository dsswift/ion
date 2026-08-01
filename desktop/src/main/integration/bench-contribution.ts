/**
 * Contribution-range and landed-detection questions for bench assembly.
 *
 * Split from bench-assemble.ts (file-size cap) at a natural seam: these two
 * functions answer "what does this member contribute?" and "has that
 * contribution already landed?" — the classification questions the assembly
 * loop asks before deciding whether a merge is even attempted. Neither
 * mutates anything.
 */
import { runGit } from '../git-runner'
import { log as _log } from '../logger'
import type { IntegrationMember } from '../../shared/types'

const TAG = 'bench.contribution'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Whether a member's pin carries any commits of its own, and the merge base that
 * proves it.
 *
 * ── Why this is asked from a RECORDED range, not a live query ────────────────
 * "This member has not committed anything yet" and "this member's work has
 * landed" are indistinguishable at assembly time. In both cases `pinnedSha` is an
 * ancestor of the source branch and `sourceBranch..pinnedSha` is empty, so every
 * available git question answers the same way. The bench read the first case as
 * the second and silently retired the member — a worktree enrolled before its
 * first commit disappeared from the list on every assembly.
 *
 * The separating fact is where the contribution STARTS, which is why the merge
 * base is captured when the pin is taken (`bench-snapshot.captureContribution`)
 * and stored as `pinnedBaseSha`. `pinnedBaseSha === pinnedSha` means empty, and
 * that survives the source branch moving underneath it.
 *
 * ── Legacy records ──────────────────────────────────────────────────────────
 * A record written before the range was tracked has `pinnedBaseSha === ''`, which
 * means UNKNOWN. It is resolved once, factually, against the member branch rather
 * than guessed: a branch with commits beyond the source branch gets its real
 * merge base backfilled and behaves exactly as before, and a branch with none is
 * empty. An unresolvable branch (deleted after a Land & retire) stays unknown and
 * falls through to the landed tiers, which is what correctly retires it.
 */
export async function resolveContribution(
  benchPath: string,
  member: IntegrationMember,
  sourceBranch: string,
): Promise<{ empty: boolean; baseSha: string }> {
  if (member.pinnedBaseSha) {
    const empty = member.pinnedBaseSha === member.pinnedSha
    log('contribution range known', {
      branch: member.branchName,
      base: member.pinnedBaseSha.slice(0, 7),
      sha: member.pinnedSha.slice(0, 7),
      empty,
    })
    return { empty, baseSha: member.pinnedBaseSha }
  }

  // Unknown: a record from before the range was tracked. Resolve it from the
  // member branch, which is the only place the answer still exists.
  try {
    const count = (await runGit(benchPath, ['rev-list', '--count', `${sourceBranch}..${member.branchName}`])).trim()
    if (count === '0') {
      log('contribution range backfilled: empty', {
        branch: member.branchName,
        source_branch: sourceBranch,
        note: 'legacy record, member branch carries no commits beyond source',
      })
      return { empty: true, baseSha: member.pinnedSha }
    }
    const base = (await runGit(benchPath, ['merge-base', member.pinnedSha, sourceBranch])).trim()
    log('contribution range backfilled: carries commits', {
      branch: member.branchName,
      commits: count,
      base: base.slice(0, 7),
    })
    return { empty: false, baseSha: base }
  } catch (err) {
    // Branch gone (the normal Land & retire outcome) or an unreadable range.
    // Stay unknown so the landed tiers below decide, which is what retires a
    // landed-and-deleted member instead of parking it as pending forever.
    log('contribution range unresolved, deferring to landed detection', {
      branch: member.branchName,
      detail: String(err).slice(0, 120),
    })
    return { empty: false, baseSha: '' }
  }
}

/**
 * True when a member's work is already contained in the source branch — i.e.
 * it has landed and is now part of the bench's base.
 *
 * ── Why this is a CONTENT question, not a sha question ──────────────────────
 * The obvious check is `merge-base --is-ancestor <pinnedSha> <sourceBranch>`,
 * and it is correct only when the landed commits are literally the pinned ones.
 * The operator's real workflow breaks that assumption routinely:
 *
 *   - **Squash before landing.** Dozens of stream-of-consciousness commits get
 *     squashed into a tight set, then landed. The squashed commit is a NEW sha,
 *     so the pinned (pre-squash) sha is not an ancestor of the source branch —
 *     even though every line of its content is now there.
 *   - **Rebase before landing.** Same outcome: rewritten shas, identical content.
 *   - **Cherry-pick.** A different sha carrying the same patch.
 *
 * In all three cases a sha-based check reports "not landed" and the bench
 * re-merges work that is already in its base — at best a redundant merge
 * commit, at worst a conflict against the operator's own landed work.
 *
 * So the question asked is the content one: **does the member branch still
 * differ from the source branch?** `git diff --quiet <source> <branch>` exits
 * zero when the trees are identical, which means everything the member has to
 * contribute is present in the base. That is true for a fast-forward, a no-ff
 * merge, a squash, a rebase, and a cherry-pick alike.
 *
 * The sha check is kept as a fast path (it is cheap and covers the common
 * unsquashed case) but the content check is the authority.
 */
export async function isLandedIntoSource(
  benchPath: string,
  member: IntegrationMember,
  sourceBranch: string,
): Promise<boolean> {
  // Tier 1 (fast path): the pinned commit itself is reachable from the source
  // branch. Covers the common land with no history rewriting.
  if (member.pinnedSha) {
    try {
      await runGit(benchPath, ['merge-base', '--is-ancestor', member.pinnedSha, sourceBranch])
      log('landed: pinned commit is an ancestor of source', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        source_branch: sourceBranch,
      })
      return true
    } catch {
      // Not an ancestor. Fall through to the content check — a squash or
      // rebase before landing makes this the NORMAL case, not an error.
    }
  }

  // Tier 2: does any commit in the source branch's history carry the member's
  // pinned TREE? This is what survives the branch being deleted — which is the
  // normal "Land & retire" outcome, where the worktree and its branch are both
  // gone by the time the bench reassembles. Without this tier a landed-then-retired
  // member is misreported as `missing`, and its work looks lost even though it
  // is sitting in the feature branch.
  if (member.pinnedTreeHash) {
    try {
      const trees = await runGit(benchPath, ['rev-list', sourceBranch, '--format=%T', '--no-commit-header'])
      if (trees.split('\n').some((t) => t.trim() === member.pinnedTreeHash)) {
        log('landed: pinned tree found in source history', {
          branch: member.branchName,
          tree: member.pinnedTreeHash.slice(0, 7),
          source_branch: sourceBranch,
          note: 'survives branch deletion after Land & retire',
        })
        return true
      }
    } catch (err) {
      log('landed: tree-history scan unavailable', { branch: member.branchName, detail: String(err).slice(0, 120) })
    }
  }

  // Tier 3: does the member branch still carry content the base lacks? An
  // identical tree means the work landed, whatever the shas look like. Requires
  // the branch to still exist, so it runs last.
  try {
    await runGit(benchPath, ['diff', '--quiet', sourceBranch, member.branchName])
    log('landed: member branch content is identical to source', {
      branch: member.branchName,
      source_branch: sourceBranch,
      note: 'squash/rebase/cherry-pick land detected by content',
    })
    return true
  } catch (err) {
    // Non-zero exit from `diff --quiet` means "trees differ" — the member
    // still has work to contribute. A missing branch also lands here and is
    // correctly treated as "not absorbed"; the missing-commit check downstream
    // reports it as `missing`.
    log('landed: member still differs from source', {
      branch: member.branchName,
      source_branch: sourceBranch,
      detail: String(err).slice(0, 120),
    })
    return false
  }
}
