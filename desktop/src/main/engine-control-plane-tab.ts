// Factory for a fresh control-plane TabEntry, extracted from
// engine-control-plane.ts to keep that file under the 600-line cap. The
// TabEntry shape and the meaning of each field are documented on the
// `TabEntry` interface in engine-control-plane-events.ts; this module owns
// only the zero-value construction so there is a single place that seeds a
// brand-new tab's bookkeeping.
import { randomUUID } from 'crypto'
import { log as _log } from './logger'
import type { TabEntry } from './engine-control-plane-events'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Build a control-plane TabEntry in its initial, never-run state. Every field
 * is seeded to its neutral default: no conversation bound, no run in flight,
 * auto permission mode, and no pending proposal surfaced. Callers (createTab /
 * the lazy ensure-on-event path) set the tab live from here.
 */
export function makeEmptyTab(tabId: string): TabEntry {
  return {
    tabId,
    status: 'idle',
    activeRequestId: null,
    automationCausation: undefined,
    conversationId: null,
    engineSessionStarted: false,
    lastActivityAt: Date.now(),
    promptCount: 0,
    promptCountSinceCheckpoint: 0,
    clearedSinceLastPrompt: false,
    resumedSavedConversation: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: 0,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    dispatchRunEpoch: null,
    lastObservedRunEpoch: null,
    dispatchAcknowledged: false,
  }
}

/**
 * Mint a brand-new tab and register it in the plane's tabs map. Used for
 * user-initiated new tabs. Returns the freshly minted id.
 *
 * Extracted from EngineControlPlane.createTab so the class stays under the
 * 600-line cap; the class method is a thin delegator.
 */
export function registerNewTab(tabs: Map<string, TabEntry>): string {
  const tabId = randomUUID()
  log('create_tab', { tab_id: tabId })
  tabs.set(tabId, makeEmptyTab(tabId))
  return tabId
}

/**
 * Register a tab under a CALLER-SUPPLIED id instead of minting one.
 *
 * The restore path reuses the persisted, durable tabId (PersistedTab.id) so
 * the session key is invariant across restarts and the engine's
 * key→conversationId binding store hits on every relaunch. Unlike
 * registerNewTab, this never generates a new id — it adopts the persisted one.
 * Idempotent: if the id is already registered (e.g. a double-restore race), the
 * existing TabEntry is preserved rather than reset, so no in-flight state is
 * clobbered. Returns the same id for call-site symmetry.
 */
export function registerAdoptedTab(tabs: Map<string, TabEntry>, tabId: string): string {
  if (tabs.has(tabId)) {
    log('adopt_tab: already registered', { tab_id: tabId })
    return tabId
  }
  log('adopt_tab', { tab_id: tabId })
  tabs.set(tabId, makeEmptyTab(tabId))
  return tabId
}

/**
 * Destructive session reset: stop the session AND drop the conversation so the
 * next prompt mints a fresh one. This is the legitimate behaviour ONLY for the
 * Implement-plan clear-context cut (take a plan into a brand-new conversation).
 *
 * Extracted from EngineControlPlane.resetTabSession to keep the class under the
 * 600-line cap; the class method delegates here, passing its stopSession bound.
 */
export function resetTabEntry(
  tabs: Map<string, TabEntry>,
  tabId: string,
  stopSession: (tabId: string) => void,
): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  log('reset_tab_session', { tab_id: tabId })
  stopSession(tabId)
  tab.conversationId = null
  tab.engineSessionStarted = false
  tab.promptCount = 0
  // Full session reset advances the freshness checkpoint: the next
  // slash command on this tab is the first prompt of a blank session.
  tab.promptCountSinceCheckpoint = 0
  tab.clearedSinceLastPrompt = false
  // Full reset drops the conversationId, so the tab is no longer resuming a
  // saved conversation — the next start mints fresh. Clear the flag.
  tab.resumedSavedConversation = false
  tab.activeRequestId = null
  tab.automationCausation = undefined
  tab.status = 'idle'         // Prevent stale events from the dying session
  tab.startedAt = 0           // from triggering task_complete synthesis
  // A full reset discards any pending proposal: clear the surfaced-proposal
  // dedup so a proposal produced by the next session re-surfaces.
  tab.lastSurfacedProposalSig = null
  // A full reset discards any in-flight dispatch, so the ordering markers it
  // established are meaningless. Leaving them would let a stale epoch judge a
  // snapshot from the next session.
  tab.dispatchRunEpoch = null
  tab.dispatchAcknowledged = false
}

/**
 * Non-destructive session restart: power-cycle the engine session WITHOUT
 * cutting a new conversation.
 *
 * Unlike resetTabEntry (which drops conversationId), this is a same-session
 * restart: stop the dying session and clear in-flight/run flags so the next
 * prompt re-StartSessions, but PRESERVE conversationId and
 * resumedSavedConversation so the engine resumes the SAME conversation with
 * full history. The correct primitive for stuck-tab auto-recovery — a stuck tab
 * is turned off and on again, not amputated. Cutting a new session id for a
 * simple recovery is destructive and was a source of the
 * conversation-fragmentation defect.
 *
 * Extracted from EngineControlPlane.restartTabSession to keep the class under
 * the 600-line cap; the class method delegates here.
 */
export function restartTabEntry(
  tabs: Map<string, TabEntry>,
  tabId: string,
  stopSession: (tabId: string) => void,
): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  log('restart_tab_session', { tab_id: tabId, conversation_id: tab.conversationId ?? '' })
  stopSession(tabId)
  // Clear ONLY the run/inflight state so the next prompt re-StartSessions.
  tab.engineSessionStarted = false
  tab.activeRequestId = null
  tab.automationCausation = undefined
  tab.status = 'idle'         // Prevent stale events from the dying session
  tab.startedAt = 0           // from triggering task_complete synthesis
  // The restart cancels any in-flight dispatch, so its ordering markers no
  // longer describe anything live.
  tab.dispatchRunEpoch = null
  tab.dispatchAcknowledged = false
  // Deliberately NOT cleared: conversationId, resumedSavedConversation,
  // promptCount, promptCountSinceCheckpoint, clearedSinceLastPrompt. The
  // conversation continues — only the transport is recycled.
}

/**
 * Drop a tab from the plane and stop its engine session.
 *
 * Lives here with the other TabEntry lifecycle functions (make / adopt / reset
 * / restart) rather than in the class: closing is the terminal member of that
 * same family, and keeping it apart from them was only an accident of where
 * the method happened to sit.
 */
export function closeTabEntry(
  tabs: Map<string, TabEntry>,
  tabId: string,
  stopSession: (tabId: string) => void,
): void {
  if (!tabs.has(tabId)) return
  log('close_tab', { tab_id: tabId })
  stopSession(tabId)
  tabs.delete(tabId)
}

/**
 * Mark the tab's conversation as cleared (the engine's `/clear` command has
 * succeeded, or the desktop short-circuited a `/clear` locally for a
 * never-started session).
 *
 * Unlike resetTabEntry, this does NOT stop the engine session, drop
 * `conversationId`, or zero `promptCount`. `/clear` is a checkpoint, not a
 * session restart — the engine keeps the same conversationID and the on-disk
 * file (now empty) is reused. The only thing that changes from the desktop's
 * perspective is the freshness checkpoint the slash-command plan->auto guard
 * consults: the next slash command should behave as if it is the first prompt
 * of a blank conversation.
 *
 * Intentionally a narrow sibling of resetTabEntry — it only resets
 * `promptCountSinceCheckpoint`. See the TabEntry doc comment in
 * engine-control-plane-events-types.ts for the full semantic distinction.
 */
export function markConversationCleared(tabs: Map<string, TabEntry>, tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) {
    log('notify_conversation_cleared: no such tab', { tab_id: tabId })
    return
  }
  log('notify_conversation_cleared', {
    tab_id: tabId,
    prompt_count: tab.promptCount,
    prompt_count_since_checkpoint: tab.promptCountSinceCheckpoint,
    conversation_id: tab.conversationId ?? '',
  })
  tab.promptCountSinceCheckpoint = 0
  tab.clearedSinceLastPrompt = true
}

