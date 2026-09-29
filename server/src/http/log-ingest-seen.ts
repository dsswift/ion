/**
 * Which forwarded browser lines a subject already delivered.
 *
 * A browser keeps every line the server has not confirmed in sessionStorage,
 * so it survives the sign-in page load. A line the server accepted while the
 * page was unloading is never confirmed, and the next page sends it again.
 * Each line carries a random `fields.line_id`; a repeat of an id this subject
 * sent recently is answered as delivered and not written twice.
 */

/** Recent ids remembered per subject: comfortably more than a page holds (desktop's MAX_BUFFERED). */
const IDS_PER_SUBJECT = 1_000
/** Subjects tracked at once, the same bound the budget uses. */
const MAX_TRACKED_SUBJECTS = 1_000

const seen = new Map<string, Set<string>>()

/** Whether `subject` already delivered the line `lineId`. */
export function isRepeatWebLine(subject: string, lineId: string): boolean {
  return seen.get(subject)?.has(lineId) ?? false
}

/** Remember that `subject` delivered `lineId`, forgetting the oldest ids past the bound. */
export function rememberWebLine(subject: string, lineId: string): void {
  let ids = seen.get(subject)
  if (!ids) {
    if (seen.size >= MAX_TRACKED_SUBJECTS) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    ids = new Set()
    seen.set(subject, ids)
  }
  ids.add(lineId)
  if (ids.size > IDS_PER_SUBJECT) {
    const oldest = ids.values().next().value
    if (oldest !== undefined) ids.delete(oldest)
  }
}

/** TEST ONLY. */
export function _resetSeenForTest(): void {
  seen.clear()
}
