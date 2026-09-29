/**
 * Bench git invocations run with the repository's hooks turned off.
 *
 * ── Why a bench commit must never run an operator hook ───────────────────────
 * Every commit a bench makes is machine-generated and disposable: the bench
 * branch is recreated from scratch on the next assembly and is never pushed.
 * The repository's hooks are written for the operator's real commits, and they
 * routinely shell out to tooling that a GUI-launched process does not have on
 * its PATH. When such a hook exits non-zero, git refuses the commit — the
 * merge itself has already succeeded and the index is clean, so the assembly
 * fails for a reason that has nothing to do with the contribution being
 * merged, and the operator is sent looking for a collision that never existed.
 *
 * Spread into every bench git invocation that can create a commit. `/dev/null`
 * is a file, so no hook path underneath it can resolve on any platform, which
 * makes this a disable rather than a redirect.
 */
export const HOOKS_OFF: readonly string[] = ['-c', 'core.hooksPath=/dev/null']
