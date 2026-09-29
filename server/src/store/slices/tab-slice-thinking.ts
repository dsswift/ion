import type { StoreSet, StoreGet } from '../session-store-types'
import type { ThinkingEffort } from '@ion/shared/types-session'
import { commitInstance } from '../conversation-instance'

/**
 * Apply a per-conversation thinking-effort change to the active conversation.
 * Extracted from tab-slice.ts to keep that file under the 600-line cap.
 *
 * DATA-driven, no tab-type fork: the effort lives on the active conversation
 * INSTANCE for every tab (a plain conversation's single `main` instance, an
 * extension-backed tab's active instance). The unified `submit` reads it from
 * the instance at prompt-submit time and rides it on the next send_prompt as
 * `thinkingEffort` (live, no restart). There is no engine call here — unlike
 * permission mode, the effort is a per-prompt override, not a session command.
 */
export function applySetThinkingEffort(set: StoreSet, get: StoreGet, effort: ThinkingEffort): void {
  const { activeTabId } = get()
  set((s) => ({
    conversationPanes: commitInstance(s.conversationPanes, activeTabId, (inst) => ({
      ...inst,
      thinkingEffort: effort,
    })),
  }))
}
