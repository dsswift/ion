/**
 * message-rows — small pure helpers the event reducer uses on a conversation's
 * message list. Kept out of event-slice.ts, which carries a size exception
 * for its one reducer switch and should not grow for anything else.
 */
import type { Message } from "@ion/shared/types";

/** Index of the last row matching `test`, or -1. */
export function lastIndexWhere(rows: readonly Message[], test: (m: Message) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) return i;
  return -1;
}
