/**
 * Deciding whether an auto-settle change needs a confirmation.
 *
 * Auto-settle files idle conversations away, so it must never come as a
 * surprise. Turning it on, or shortening its window, can settle conversations
 * on the very next sweep. Before either takes effect the server is asked what
 * that sweep would settle (`inbox.previewAutoSettle`, the sweep's own
 * predicate), and the person confirms the number. Turning it off, or
 * lengthening the window, settles nothing and needs no confirmation.
 */
export interface AutoSettlePreview {
  count: number
  titles: string[]
}

/** True when moving from `current` to `next` days could settle conversations that are open now. */
export function autoSettleChangeCanSettle(current: number, next: number): boolean {
  if (next <= 0) return false
  if (current <= 0) return true
  return next < current
}

export function isAutoSettlePreview(value: unknown): value is AutoSettlePreview {
  const v = value as Partial<AutoSettlePreview> | null
  return !!v && typeof v.count === 'number' && Array.isArray(v.titles) && v.titles.every((t) => typeof t === 'string')
}
