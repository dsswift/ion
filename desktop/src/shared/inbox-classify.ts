/**
 * inbox-classify — pure derivation of a conversation's inbox state.
 *
 * Settle and snooze are DERIVED OVERLAYS, not stored buckets (t3 semantics,
 * Ion idioms): blocked/working conversations never classify as settled;
 * snooze expiry is computed at render time (snoozedUntil <= now stops
 * classifying); a snoozed conversation resurfaces early on a "raised hand"
 * (pending ask, fresh error, completion after the snooze was set).
 *
 * The desktop computes; clients render (parity-table precedent: worktree
 * dirty/needsSync). iOS receives the derived inboxState + raw fields and
 * never re-derives in Swift.
 */

export type InboxState = 'active' | 'snoozed' | 'settled'

/** The subset of TabState the classifier reads (structural — testable). */
export interface InboxTabView {
  status: string
  settledOverride: 'settled' | 'active' | 'auto' | null
  settledAt: number | null
  snoozedUntil: number | null
  snoozedAt: number | null
  lastVisitedAt: number | null
  lastCompletionAt: number | null
  /** Last real user/assistant message. This is the only inbox age clock. */
  lastMessageAt?: number | null
  /** Legacy diagnostics value. Never used by inbox derivation. */
  lastActivityAt?: number | null
  manualUnread: boolean
  /** Exact engine verdict that accepted background or delivery work remains. */
  hasPendingWork?: boolean
  /** Plan exists but has not been implemented or dismissed. */
  hasPendingPlan?: boolean
  /** Pending permission/elicitation asks (blocked-on-you). */
  pendingAskCount: number
  /** Plan-ready / question waiting state present. */
  waiting: boolean
  /** Last run failed (fresh error signal for the raised hand). */
  failed: boolean
}

/** A snoozed conversation's early-resurface conditions. */
export function raisedHand(tab: InboxTabView): boolean {
  if (tab.pendingAskCount > 0 || tab.waiting) return true
  if (tab.failed) return true
  // A real message after snooze means the conversation spoke while parked.
  if (tab.lastMessageAt != null && tab.snoozedAt != null && tab.lastMessageAt > tab.snoozedAt) return true
  return false
}

/** Effective snooze: wake time in the future AND no raised hand. */
export function effectiveSnoozed(tab: InboxTabView, now: number): boolean {
  if (tab.snoozedUntil == null || tab.snoozedUntil <= now) return false
  return !raisedHand(tab)
}

/**
 * Returns the reason automatic settlement must refuse this conversation.
 * Manual settlement remains an explicit operator choice and does not use it.
 */
export function autoSettleBlocked(tab: InboxTabView): string | null {
  if (tab.status === 'running' || tab.status === 'connecting' || tab.status === 'starting' || tab.status === 'waiting') return 'session_active'
  if (tab.hasPendingWork) return 'background_work_pending'
  if (tab.hasPendingPlan) return 'plan_pending'
  if (tab.pendingAskCount > 0) return 'operator_decision_pending'
  if (tab.waiting) return 'waiting_for_input'
  return null
}

/**
 * Effective settle. Explicit manual and automatic settlement are both durable
 * hard states: the input is locked and the engine session is stopped. They
 * differ only in provenance, which callers render as a subdued Auto marker.
 * A user’s explicit active override suppresses the clock.
 */
export function effectiveSettled(tab: InboxTabView, now: number, autoSettleDays: number | null): boolean {
  if (tab.settledOverride === 'settled' || tab.settledOverride === 'auto') return true
  if (tab.settledOverride === 'active') return false
  if (autoSettleBlocked(tab) !== null) return false
  if (autoSettleDays == null) return false
  // D8: snoozed tabs are exempt from the auto-settle clock.
  if (effectiveSnoozed(tab, now)) return false
  if (tab.lastMessageAt == null) return false
  return now - tab.lastMessageAt > autoSettleDays * 24 * 60 * 60 * 1000
}

/**
 * Inbox unread: manual marker, or a real message newer than the last visit.
 * Never-visited counts as READ (upgrade-day rule, R9/D9: pre-existing tabs
 * with lastVisitedAt null must not all light up unread after the upgrade).
 */
export function inboxUnread(tab: InboxTabView): boolean {
  if (tab.manualUnread) return true
  if (tab.lastMessageAt == null) return false
  if (tab.lastVisitedAt == null) return false
  return tab.lastMessageAt > tab.lastVisitedAt
}

/** Wake moment for the "Woke" pill: a snooze that expired after the last visit. */
export function wokeAt(tab: InboxTabView, now: number): number | null {
  if (tab.snoozedUntil == null) return null
  if (tab.snoozedUntil > now) return null // still snoozed
  if (tab.lastVisitedAt != null && tab.lastVisitedAt >= tab.snoozedUntil) return null // visited since wake
  return tab.snoozedUntil
}

/** Full classification for one conversation. */
export function classifyInbox(tab: InboxTabView, now: number, autoSettleDays: number | null): InboxState {
  if (effectiveSnoozed(tab, now)) return 'snoozed'
  if (effectiveSettled(tab, now, autoSettleDays)) return 'settled'
  return 'active'
}

/**
 * Status-dot unread (R9): the persisted, cross-device derivation that
 * SUPERSEDES the old local-only `hasUnread` flag. Same rule as inboxUnread
 * but over the minimal structural subset every dot renderer has.
 *
 * Intentional overlay behavior change (D9, stated in the PR): dots survive
 * restart, can appear for completions that happened while the app was
 * closed, and sync cross-device via the snapshot.
 */
export function tabUnread(tab: {
  manualUnread: boolean
  lastMessageAt?: number | null
  lastVisitedAt: number | null
}): boolean {
  if (tab.manualUnread) return true
  if (tab.lastMessageAt == null) return false
  if (tab.lastVisitedAt == null) return false // never-visited = read (upgrade day)
  return tab.lastMessageAt > tab.lastVisitedAt
}
