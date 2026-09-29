/**
 * Monotonic revisions for the owner snapshots a client dedupes by revision.
 *
 * Two paths carry the same state to a client: the first-paint snapshot on
 * `studio_welcome`, and the delta published on every change. The client keeps
 * the highest revision it has seen and ignores anything at or below it, so
 * both paths MUST draw from one sequence -- separate counters would let a
 * delta land below the handshake snapshot and be silently dropped.
 *
 * This also fixes a harder failure: the publishers previously sent no
 * `revision` at all, and the client's validator requires a safe integer, so
 * every delta was rejected as malformed. That is invisible on the Electron
 * window, which pulls a properly stamped snapshot over IPC, and total on a
 * browser client, which has only these frames.
 */

let worktreeRevision = 0
let terminalRevision = 0

/** Next revision for a worktree read-model snapshot (handshake or delta). */
export function nextWorktreeRevision(): number {
  worktreeRevision += 1
  return worktreeRevision
}

/** Next revision for a Conversation Terminal Panel snapshot (handshake or delta). */
export function nextTerminalRevision(): number {
  terminalRevision += 1
  return terminalRevision
}

/** TEST ONLY. Resets both sequences so a test's assertions start from a known point. */
export function _resetStudioRevisionsForTest(): void {
  worktreeRevision = 0
  terminalRevision = 0
}
