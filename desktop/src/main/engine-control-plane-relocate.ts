/**
 * Conversation relocation — move a LIVE conversation to a different working
 * directory without cutting a new conversation.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Before this, the only way to change a tab's working directory was
 * `setBaseDirectory` (renderer), which calls `resetTabSession` and nulls
 * `conversationId` BY DESIGN — it means "start a fresh conversation over
 * there". That is correct for its own use case and wrong for relocation: it
 * destroys the history.
 *
 * The consequence was that a conversation could not outlive its directory. A
 * worktree conversation had to be closed when its worktree was removed, which
 * is why "Finish work" fused integrate + destroy + close.
 *
 * ── The composition ─────────────────────────────────────────────────────────
 * Two existing primitives already do the halves of this correctly:
 *
 *   1. `restartTabEntry` (engine-control-plane-tab.ts) — power-cycles the
 *      engine session and clears ONLY the in-flight/run flags. It explicitly
 *      PRESERVES `conversationId` and `resumedSavedConversation`: the
 *      conversation continues, only the transport is recycled.
 *   2. `ensureSession` (engine-control-plane.ts) — starts a session with a
 *      CALLER-SUPPLIED `workingDirectory` plus the tracked `conversationId`,
 *      so the engine resumes the same conversation in the new location.
 *
 * Relocation is exactly (1) then (2). No new engine API, no wire change, and
 * no conversation identity change — which is why this lives in the consumer
 * rather than the engine (see docs/engine-grounding.md § 5).
 *
 * The engine-side half of the story is `syncConversationWorkingDirectory` in
 * `engine/internal/backend/runloop_working_dir.go`: the next run persists the
 * new path onto the conversation record, so a LATER resume from the session
 * browser also opens in the new location instead of the dead one.
 */
import { log as _log, warn as _warn } from './logger'
import type { TabEntry } from './engine-control-plane-events'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface RelocateResult {
  ok: boolean
  /** The conversation carried across the relocation (empty when the tab had none yet). */
  conversationId?: string
  error?: string
}

/**
 * Dependencies the relocation needs from the control plane. Passed in rather
 * than imported so this module stays testable without an EngineBridge.
 */
export interface RelocateDeps {
  /** Non-destructive session restart (restartTabEntry-backed). Preserves conversationId. */
  restartSession: (tabId: string) => void
  /** Idempotent start with a caller-supplied working directory. */
  ensureSession: (
    tabId: string,
    opts: { workingDirectory: string; conversationId?: string | null; permissionMode?: 'auto' | 'plan' },
  ) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Relocate `tabId`'s live conversation to `workingDirectory`.
 *
 * Preconditions and their outcomes are all logged: an unknown tab, an empty
 * target, and a failed restart are each distinguishable in ~/.ion/desktop.jsonl
 * without a debugger.
 *
 * Returns `{ ok: false, error }` rather than throwing so callers (IPC handlers)
 * can surface an actionable message.
 */
export async function relocateTabSession(
  tabs: Map<string, TabEntry>,
  tabId: string,
  workingDirectory: string,
  deps: RelocateDeps,
): Promise<RelocateResult> {
  const tab = tabs.get(tabId)
  if (!tab) {
    warn('relocate_session: unknown tab', { tab_id: tabId, dir: workingDirectory })
    return { ok: false, error: `Unknown tab ${tabId}` }
  }
  if (!workingDirectory) {
    warn('relocate_session: empty target directory', { tab_id: tabId, conversation_id: tab.conversationId ?? '' })
    return { ok: false, error: 'Relocation requires a target working directory' }
  }

  const conversationId = tab.conversationId
  log('relocate_session: starting', {
    tab_id: tabId,
    conversation_id: conversationId ?? '',
    to: workingDirectory,
    permission_mode: tab.permissionMode,
  })

  // Step 1 — recycle the transport, keeping the conversation. restartTabEntry
  // clears engineSessionStarted so the ensureSession below actually starts
  // (it no-ops when the flag is set) while leaving conversationId intact.
  deps.restartSession(tabId)

  // Step 2 — start again in the new directory, resuming the same conversation.
  // conversationId is passed explicitly (not left to the tracked value alone)
  // so the intent is visible on the call and in the ensure_session log line.
  const result = await deps.ensureSession(tabId, {
    workingDirectory,
    conversationId,
    permissionMode: tab.permissionMode,
  })

  if (!result.ok) {
    warn('relocate_session: ensureSession failed', {
      tab_id: tabId,
      conversation_id: conversationId ?? '',
      to: workingDirectory,
      error: result.error ?? 'unknown',
    })
    return { ok: false, conversationId: conversationId ?? undefined, error: result.error }
  }

  // Read the tracked id back AFTER the start: a tab that had no conversation
  // yet gets one minted here, and the caller wants the real id.
  const finalConversationId = tabs.get(tabId)?.conversationId ?? conversationId
  log('relocate_session: live', {
    tab_id: tabId,
    conversation_id: finalConversationId ?? '',
    dir: workingDirectory,
    conversation_preserved: !!conversationId && finalConversationId === conversationId,
  })
  return { ok: true, conversationId: finalConversationId ?? undefined }
}
