import type { Message, Attachment } from '../../shared/types'
import type { SessionLoadMessage } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { commitInstance, activeInstance } from '../stores/conversation-instance'
import { rInfo, rWarn } from '../rendererLogger'

/**
 * useTabRestoration-images — reconcile engine-produced image attachments onto
 * a restored extension-hosted conversation's scrollback.
 *
 * Why this exists (the #224 desktop resume gap):
 *
 * Extension-hosted tabs restore from the persisted desktop cache
 * (buildPopulatedInstance reads PersistedConversationInstance.messages) and,
 * unlike plain conversations (resumeSession / loadSkeletonMessages), never call
 * `load_session_history`. So they never see the engine's `flattenEntries`
 * output, which is the ONLY reload path that re-derives image attachments from
 * the persisted image blocks (engine/internal/conversation/list.go).
 *
 * The persisted cache can carry zero attachments for two reasons:
 *   1. Historical data written before the desktop's live image path was wired
 *      (the main-process `engine_image_content` producer arm was missing, so
 *      images never attached live and never persisted).
 *   2. Any instance whose scrollback predates attachment persistence.
 *
 * The engine's on-disk conversation file is the authoritative source: its
 * image blocks carry the tool_use_id association, and `flattenEntries` attaches
 * each image to the owning tool row. This reconciler loads that authoritative
 * history and merges any attachments it finds onto the matching restored
 * messages (keyed by toolId), so the images reappear even for caches that were
 * written without them. It is additive and idempotent: an attachment already
 * present on the restored row (same path) is never duplicated.
 */

/**
 * Return the set of on-disk paths referenced by an attachment list, so a merge
 * can dedup by path (the same content-addressed file the engine and desktop
 * both converge on).
 */
function attachmentPaths(attachments: readonly Attachment[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const a of attachments ?? []) {
    const p = (a as { path?: string }).path
    if (p) out.add(p)
  }
  return out
}

/**
 * Merge image attachments from an authoritative engine history (the
 * `load_session_history` / `flattenEntries` output) onto a restored client
 * `Message[]`, keyed by toolId. Pure: returns a new array only when at least
 * one attachment was added; otherwise returns the input array unchanged so the
 * caller can skip a no-op setState.
 *
 * Matching rule mirrors the engine: history rows carry attachments on the
 * owning tool-call row (flattenEntries attaches user-block images to the tool
 * row by ToolUseID). We index restored messages by toolId and fold each
 * history row's attachments onto the matching restored tool row, deduped by
 * on-disk path. History rows with no attachments, no toolId, or no matching
 * restored row are ignored.
 *
 * Exported for unit testing the merge at a stable, pure seam.
 */
export function mergeHistoryAttachments(
  messages: Message[],
  history: readonly SessionLoadMessage[],
): Message[] {
  // Index restored messages by toolId (tool rows are the only attachment
  // carriers the engine's flattenEntries produces).
  const byToolId = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const id = messages[i].toolId
    if (id) byToolId.set(id, i)
  }

  let next: Message[] | null = null
  for (const h of history) {
    const atts = h.attachments
    if (!atts || atts.length === 0) continue
    if (!h.toolId) continue
    const idx = byToolId.get(h.toolId)
    if (idx === undefined) continue

    const target = (next ?? messages)[idx]
    const existing = attachmentPaths(target.attachments)
    const additions = atts.filter((a) => {
      const p = (a as { path?: string }).path
      return !!p && !existing.has(p)
    })
    if (additions.length === 0) continue

    if (!next) next = [...messages]
    next[idx] = { ...target, attachments: [...(target.attachments ?? []), ...additions] }
  }

  return next ?? messages
}

/**
 * Reconcile image attachments from the engine's authoritative history onto a
 * restored extension-hosted conversation's active instance.
 *
 * Loads the full session chain via `load_session_history` (the engine's
 * flattenEntries output — the only reload path that re-derives image
 * attachments from persisted image blocks) and merges any attachments onto the
 * matching restored tool rows via `mergeHistoryAttachments`. The whole chain is
 * read (not just the current session) so images on historical, pre-checkpoint
 * sessions reconcile too, matching loadSkeletonMessages' chain read.
 *
 * Additive and idempotent: a cache that already carries its attachments merges
 * to a no-op and no setState fires. Best-effort — a load failure is logged and
 * swallowed so a transient engine hiccup never blocks tab restore.
 */
export async function reconcileRestoredImages(
  tabId: string,
  key: string,
  conversationIds: readonly string[],
  tabConversationId: string | null | undefined,
  instSessionId: string,
): Promise<void> {
  try {
    const chainIds = [...conversationIds, tabConversationId].filter(
      (id): id is string => !!id,
    )
    const historyIds = chainIds.length > 0 ? chainIds : instSessionId ? [instSessionId] : []
    rInfo('restore', 'image reconcile: start', {
      key,
      history_ids: historyIds.length,
      conversation_ids: conversationIds.length,
      tab_conversation_id: tabConversationId ?? '',
      inst_session_id: instSessionId,
    })
    if (historyIds.length === 0) {
      // No resolvable conversation to load history from — nothing to reconcile.
      rInfo('restore', 'image reconcile: no history ids, skipping', { key })
      return
    }

    const history = await window.ion.loadChainHistory(historyIds)
    const historyAttachments = history.reduce((n, h) => n + (h.attachments?.length ?? 0), 0)
    rInfo('restore', 'image reconcile: loaded history', {
      key,
      history_messages: history.length,
      history_attachments: historyAttachments,
    })
    useSessionStore.setState((s) => {
      const active = activeInstance(s.conversationPanes, tabId)
      if (!active) {
        // Pane/instance missing at merge time (tab closed or not yet hydrated).
        rWarn('restore', 'image reconcile: no active instance at merge time', { key })
        return {}
      }
      const merged = mergeHistoryAttachments(active.messages, history)
      if (merged === active.messages) {
        // Merge was a no-op: every history attachment already present (idempotent
        // re-run) or none matched a restored toolId. Logged so a "did it run?"
        // question is answerable without guessing.
        rInfo('restore', 'image reconcile: merge no-op (already present or no toolId match)', {
          key,
          restored_messages: active.messages.length,
          history_attachments: historyAttachments,
        })
        return {}
      }
      const added = merged.reduce((n, m) => n + (m.attachments?.length ?? 0), 0)
      rInfo('restore', 'reconciled image attachments from engine history', { key, attachments: added })
      return {
        conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          messages: merged,
        })),
      }
    })
  } catch (err: any) {
    rWarn('restore', 'image attachment reconcile failed', { key, error: err?.message ?? String(err) })
  }
}
