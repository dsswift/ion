import type { StatusFields } from './types-engine'

/**
 * background-shell-counts — the canonical way to ask "how many background
 * shells does this engine instance have?".
 *
 * The engine answers that question with TWO different fields, and they mean
 * different things:
 *
 *   • `statusFields.backgroundShells` — how many notifying commands (Bash
 *     `run_in_background` + `notify_on_complete`) the session is HELD OPEN
 *     for. The engine parks the session on these and wakes it when they
 *     finish, so this is the "the engine is waiting" count. A fire-and-forget
 *     command is deliberately excluded: nothing is waiting on it.
 *     (engine/internal/session/status_work_snapshot.go, from
 *     `s.outstandingBackgroundTasks`.)
 *
 *   • `statusFields.activeBackgroundTasks` — the complete snapshot of every
 *     LIVE session-owned background Bash process, notifying or not
 *     (engine/internal/tools/background_task_control.go
 *     `BackgroundTasksForOwner`, filtered to `Status == "running"`).
 *
 * Every "is work in flight in this tab?" surface wants the SECOND one. A
 * detached `run_in_background` command is a real process that the engine kills
 * when the session stops (`StopBackgroundTasksForOwner`), so a tab holding one
 * is not done: closing it, converting it, auto-settling it, or moving it to a
 * Done group all destroy live work.
 *
 * Reading `backgroundShells` for that question was a real defect: a 96-second
 * detached command left the composer badge blank, the tab dot green, the tab
 * auto-moved to the Done group, and the inbox filed the conversation as done —
 * while the pink Bash operation group (the one surface that reads
 * `activeBackgroundTasks`) correctly showed the command still running.
 *
 * Only the wording of a "the engine is waiting for these" label may use the
 * held count, because that claim is false for a detached command.
 */

/**
 * The subset of StatusFields these folds read.
 *
 * Structural rather than `Pick<StatusFields, …>` so the callers that already
 * declare their own minimal instance shape (session-busy-guard's `GuardInstance`,
 * the remote-projection input types) can pass their field bag without adopting
 * the full engine type. `activeBackgroundTasks` is read for its length only.
 */
export interface ShellCountFields {
  backgroundShells?: number
  activeBackgroundTasks?: ReadonlyArray<unknown>
}

/** Compile-time proof that a real StatusFields satisfies the shape above. */
const _statusFieldsIsAssignable: (fields: StatusFields) => ShellCountFields = (fields) => fields
void _statusFieldsIsAssignable

/**
 * Every live session-owned background Bash process, notifying or not. This is
 * the count for any "is work in flight?" decision.
 *
 * Takes the MAX of the two engine fields rather than trusting the task list
 * alone. They are normally consistent (the notifying set is a subset of the
 * live set), but two cases make the max the honest answer: the engine's
 * `maxOutstanding` cap starts a notifying command WITHOUT tracking it as
 * outstanding, and a snapshot from an engine that predates
 * `activeBackgroundTasks` carries only the scalar. Never sum them — both
 * fields observe the same processes.
 */
export function liveBackgroundShellCount(fields: ShellCountFields | null | undefined): number {
  const live = fields?.activeBackgroundTasks?.length ?? 0
  const held = fields?.backgroundShells ?? 0
  return Math.max(live, held)
}

/**
 * Only the commands the engine is actually holding the session open for.
 * Use this exclusively to decide whether "waiting for …" phrasing is true.
 */
export function heldBackgroundShellCount(fields: ShellCountFields | null | undefined): number {
  return fields?.backgroundShells ?? 0
}
