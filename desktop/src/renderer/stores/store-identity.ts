// store-identity.ts — reference-identity preservation for the hot event path.
//
// Zustand notifies every subscriber whose selected value changed by reference.
// The normalized-event reducer runs on every engine event, so any state it
// rebuilds unconditionally is a re-render broadcast to every component holding
// that slice — whether or not anything the component displays actually moved.
//
// Two slices dominate that cost because they are the widest subscriptions in
// the app: `tabs` (held bare by ~10 components, several of which map over the
// full list) and `conversationPanes` (held bare by the tab strip and by every
// tab pill). With many tabs open and several agents streaming, rebuilding
// either one per event is what pins the renderer's main thread.
//
// These helpers let the reducer answer "did anything actually change?" and
// hand back the original object when the answer is no.

import type { TabState } from '../../shared/types-session'
import type { ConversationInstance } from '../../shared/types-engine'

/**
 * Minimum gap between `lastEventAt` writes, in ms.
 *
 * `lastEventAt` is read by exactly two surfaces: the tab pill's relative-time
 * label ("· 3m", via formatRelativeShort) and the staleness watchdogs in
 * session-store-persistence / permissions-slice, which compare against
 * multi-second thresholds. Neither can resolve better than a second, but
 * stamping Date.now() on every event gave the tab a new object — and `tabs` a
 * new array — for every event even when nothing else on the tab changed.
 * Coalescing to a 1s floor keeps both readers exact and lets the vast majority
 * of events leave the array reference untouched.
 */
export const LAST_EVENT_AT_COALESCE_MS = 1000

/**
 * Whether `lastEventAt` should be restamped now. Returns false while the
 * previous stamp is still within the coalescing window.
 */
export function shouldStampLastEventAt(previous: number | null | undefined, now: number): boolean {
  if (previous === null || previous === undefined) return true
  // A clock that moved backwards (NTP correction, sleep/wake) leaves a future
  // stamp that would otherwise suppress writes until real time caught up.
  if (previous > now) return true
  return now - previous >= LAST_EVENT_AT_COALESCE_MS
}

/**
 * Shallow reference comparison of two tab objects. The reducer builds its
 * candidate with `{ ...tab }` and assigns fields into it, so every unchanged
 * field is reference-equal to the original by construction — a shallow compare
 * is exact here, not an approximation.
 */
export function sameTab(a: TabState, b: TabState): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a) as Array<keyof TabState>
  const bKeys = Object.keys(b) as Array<keyof TabState>
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * Element-wise reference comparison of two arrays. The reducer copies message
 * and queue arrays with `.slice()` before mutating them, so the copy is a new
 * array whose elements are the original references when nothing was appended
 * or replaced.
 */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Whether the rebuilt conversation instance is equivalent to the original.
 * Same construction argument as sameTab: `next` starts as a spread of `inst`,
 * so unchanged fields are reference-equal and the array fields are compared
 * element-wise because they are always freshly sliced.
 */
export function sameInstance(a: ConversationInstance, b: ConversationInstance): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a) as Array<keyof ConversationInstance>
  const bKeys = Object.keys(b) as Array<keyof ConversationInstance>
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    const av = a[k]
    const bv = b[k]
    if (av === bv) continue
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (!sameItems(av as readonly unknown[], bv as readonly unknown[])) return false
      continue
    }
    return false
  }
  return true
}

/**
 * Returns `previous` when every element of `next` is reference-equal to its
 * counterpart, so a map() that changed nothing does not invalidate the array
 * for its subscribers.
 */
export function preserveArrayIdentity<T>(previous: readonly T[], next: readonly T[]): readonly T[] {
  return sameItems(previous, next) ? previous : next
}
