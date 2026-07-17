/**
 * engine-slice-rewind — engine-tab conversation rewind action
 *
 * Extracted from engine-slice.ts to keep that file under the 600-line
 * TypeScript cap. Contains the single `rewindEngineInstance` action, which
 * truncates an engine instance's messages to a chosen point, restarts the
 * engine session, and broadcasts the truncated history to remote devices.
 *
 * Spread into the object returned by createEngineSlice.
 *
 * Target resolution: the action accepts a `messageId` and an optional
 * `userTurnIndex`. It resolves the rewind point by id first (the desktop-
 * initiated path, where the id was minted by nextMsgId() and is present in
 * inst.messages). When the id is not found — the iOS-initiated path, where the
 * target was rendered from an optimistic UUID the desktop store never minted —
 * it falls back to the Nth `role==='user'` message given by `userTurnIndex`.
 *
 * Why user-turn ordinal (not raw index): rewind only ever targets a user turn.
 * Counting user turns is invariant to tool/assistant interleaving and to the
 * optimistic-UUID id mismatch, so both sides agree on it. The invariant this
 * relies on is that the desktop's inst.messages and the iOS-rendered instance
 * list hold the same user-turn sequence at rewind time — which holds because an
 * iOS-originated engine prompt drives the desktop renderer's submitEnginePrompt
 * optimistic insert (via processIncomingPrompt → REMOTE_ENGINE_PROMPT). The
 * store test (engine-slice-rewind.test.ts) pins Nth-user-message resolution
 * against interleaved tool/assistant rows to lock this.
 */

import type { StoreSet, StoreGet, State } from '../session-store-types'
import { lastPendingCardTool } from '../../../shared/pending-card'
import { rDebug, rInfo, rWarn, rError } from '../../rendererLogger'

export function createEngineRewindActions(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    rewindEngineInstance: (tabId, instanceId, messageId, userTurnIndex) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) {
        rWarn('engine.rewind', 'rewind: tab not found', { tab_id: tabId.slice(0, 8) })
        return
      }
      const panes = new Map(get().conversationPanes)
      const pane = panes.get(tabId)
      if (!pane) {
        rWarn('engine.rewind', 'rewind: pane not found', { tab_id: tabId.slice(0, 8) })
        return
      }
      const inst = pane.instances.find((i) => i.id === instanceId)
      if (!inst) {
        rWarn('engine.rewind', 'rewind: instance not found', { tab_id: tabId.slice(0, 8), instance_id: instanceId })
        return
      }

      // Resolve the rewind point. Path 1: id match (desktop-initiated rewind,
      // where messageId is a nextMsgId() value present in inst.messages).
      let idx = inst.messages.findIndex((m) => m.id === messageId)
      if (idx >= 0) {
        rDebug('engine.rewind', 'rewind: resolved by id', { message_id: messageId, idx })
      } else if (typeof userTurnIndex === 'number' && userTurnIndex >= 0) {
        // Path 2: user-turn ordinal fallback (iOS-initiated rewind, where the
        // target was rendered from an optimistic UUID the desktop never minted).
        // Find the Nth role==='user' message in inst.messages.
        let userCount = -1
        idx = -1
        for (let i = 0; i < inst.messages.length; i++) {
          if (inst.messages[i].role === 'user') {
            userCount++
            if (userCount === userTurnIndex) {
              idx = i
              break
            }
          }
        }
        if (idx >= 0) {
          rDebug('engine.rewind', 'rewind: resolved by user turn index', { user_turn_index: userTurnIndex, idx, message_id: messageId })
        } else {
          rWarn('engine.rewind', 'rewind: user turn index out of range', { user_turn_index: userTurnIndex, tab_id: tabId.slice(0, 8), instance_id: instanceId })
          return
        }
      } else {
        rWarn('engine.rewind', 'rewind: message not found', { tab_id: tabId.slice(0, 8), instance_id: instanceId, message_id: messageId })
        return
      }

      const targetMessage = inst.messages[idx]
      const key = tabId

      // The engine rewind is addressed by user-turn ordinal (0-based). The
      // engine resolves it against its own tree, so it holds no dependency on
      // the renderer's message ids — a freshly-sent (optimistic-id) turn rewinds
      // as reliably as a history-loaded one. Count the user rows before the
      // target: this is the same Nth-user-turn the engine's flattenEntries
      // produces from the same entries, so both sides agree (the invariant the
      // store test pins against interleaved tool/assistant rows).
      let userTurnOrdinal = 0
      for (let i = 0; i < idx; i++) {
        if (inst.messages[i].role === 'user') userTurnOrdinal++
      }
      rInfo('engine.rewind', 'rewind: executing', { tab_id: key, msg_idx: idx, user_turn_ordinal: userTurnOrdinal, total_msgs: inst.messages.length, keep_msgs: idx, target_msg_len: targetMessage.content.length })

      // Move the engine's conversation leaf to before the target turn — a
      // tree-native branch on the SAME conversation. BuildContextPath rebuilds
      // the LLM context to drop the rewound-past turns, and the engine restores
      // plan-file continuity for the branch point. The next prompt appends as a
      // fresh sibling of the old turn, so it is never duplicated.
      //
      // No session stop/start: the previous client-side stop/start was defeated
      // by the engine binding store — engineStart rebound to the SAME
      // conversation ("resuming bound from binding store"), leaving pre-rewind
      // history intact so the resend appended a duplicate. The entry-id
      // branch_before that was bolted on top only fired for canonical 8-hex row
      // ids, so a freshly-sent turn (optimistic id) still duplicated. Ordinal
      // addressing removes that gap. Rewind is offered only when idle, so no
      // in-flight run races the branch.
      window.ion.engineRewind(key, userTurnOrdinal).then((res) => {
        if (!res.ok) {
          rError('engine.rewind', 'rewind: engine rewind failed', { tab_id: key, user_turn_ordinal: userTurnOrdinal, error: res.error ?? 'unknown' })
          return
        }
        rInfo('engine.rewind', 'rewind: engine branched to before turn', { tab_id: key, user_turn_ordinal: userTurnOrdinal })
        // Broadcast the truncated history so iOS replaces its now-stale message
        // list immediately, instead of waiting for a sub-tab switch to re-issue
        // load_engine_conversation. The renderer store already holds the
        // truncated inst.messages (the set() below runs synchronously first).
        window.ion.engineBroadcastHistory(tabId, instanceId).then(() => {
          rDebug('engine.rewind', 'rewind: broadcast truncated history', { tab_id: key })
        }).catch((err: any) => {
          rError('engine.rewind', 'rewind: broadcast failed', { tab_id: key, error: err.message })
        })
      }).catch((err: any) => {
        rError('engine.rewind', 'rewind: engine rewind invoke failed', { tab_id: key, error: (err as Error).message })
      })

      const rewoundMessages = inst.messages.slice(0, idx)

      // Restore permissionDenied from the last tool message in the truncated
      // history, same heuristic as CLI rewindToMessage in resume-slice.ts.
      const parseInput = (raw?: string): Record<string, unknown> | undefined => {
        if (!raw) return undefined
        try { return JSON.parse(raw) } catch { return undefined }
      }
      // Shared pending-card rule: a rewound history restores the card only when
      // the last AskUserQuestion / ExitPlanMode is still outstanding (no
      // trailing /clear divider or user message dismissed it).
      const foundCard = lastPendingCardTool(rewoundMessages)
      const restoredDenied = foundCard
        ? { tools: [{ toolName: foundCard.toolName, toolUseId: foundCard.toolId || 'restored', toolInput: parseInput(foundCard.toolInput) }] }
        : null

      // Restore planFilePath from an ExitPlanMode card's toolInput when present.
      // The ExitPlanMode toolInput carries { planFilePath } so after rewinding
      // to before the implement step the instance still knows which plan file
      // was assigned. Without this the field was unconditionally null, causing
      // the engine to allocate a new slug when the user re-entered plan mode.
      const restoredPlanFilePath: string | null =
        foundCard?.toolName === 'ExitPlanMode'
          ? (parseInput(foundCard.toolInput)?.planFilePath as string | undefined) ?? null
          : null

      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => {
          if (i.id !== instanceId) return i
          return {
            ...i,
            messages: rewoundMessages,
            messageCount: rewoundMessages.length,  // keep count in lockstep with truncated history
            modelOverride: i.modelOverride,  // preserve model selection across rewind
            sessionModel: i.sessionModel,  // same session — model is unchanged by the branch
            permissionMode: i.permissionMode, // preserve permission mode across rewind
            permissionDenied: restoredDenied,
            permissionQueue: [],
            elicitationQueue: [],
            conversationIds: i.conversationIds,  // branch stays on the SAME conversation — do not clear
            draftInput: targetMessage.content,
            agentStates: [],
            statusFields: null,
            planFilePath: restoredPlanFilePath,
          }
        }),
      })

      // Clean up compound-keyed Maps — same as resetEngineInstance.
      const engineWorkingMessages = new Map(get().engineWorkingMessages)
      const engineNotifications = new Map(get().engineNotifications)
      const engineDialogs = new Map(get().engineDialogs)
      const enginePinnedPrompt = new Map(get().enginePinnedPrompt)
      const engineUsage = new Map(get().engineUsage)
      engineWorkingMessages.delete(key)
      engineNotifications.delete(key)
      engineDialogs.delete(key)
      enginePinnedPrompt.delete(key)
      engineUsage.delete(key)

      set((state) => ({
        conversationPanes: panes,
        engineWorkingMessages,
        engineNotifications,
        engineDialogs,
        enginePinnedPrompt,
        engineUsage,
        // Set pendingInput on the parent TabState so InputBar pre-fills
        // immediately (same one-shot pattern as CLI rewindToMessage).
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, pendingInput: targetMessage.content }
            : t
        ),
      }))
    },
  }
}
