/**
 * engine-slice-rewind — engine-tab conversation rewind action
 *
 * Extracted from engine-slice.ts to keep that file under the 600-line
 * TypeScript cap. Contains the single `rewindEngineInstance` action, which
 * validates a rewind target, asks the engine to branch its tree, and only on
 * SUCCESS truncates the instance's messages, tears down the running session,
 * pre-fills the input bar, and replaces the Studio/iOS transcript.
 *
 * Spread into the object returned by createEngineSlice.
 *
 * TRANSACTIONAL BY DESIGN. The prior implementation truncated local state
 * synchronously and only THEN awaited window.ion.engineRewind — so a
 * rejected rewind (an unknown, foreign-branch, or already-consumed target)
 * left the owner's transcript truncated while the engine's tree was
 * untouched, silently diverging the two. This version calls the engine
 * FIRST and performs every local mutation (message truncation, draft/
 * prefill, Studio/iOS history replacement) only in the success branch.
 *
 * Target resolution: the action accepts a `messageId` and an optional
 * `userTurnIndex`. It first locates the row by id in inst.messages, then
 * decides which rewind mode to use:
 *   - EXACT ENTRY ID: the located row's id is a durable engine-assigned
 *     entry id (not a `msg-N` optimistic id the desktop itself minted) —
 *     e.g. a row re-keyed by `user_turn_persisted` or a delivered
 *     `steer_injected`, or any history-loaded row. Send it as `entryId`; the
 *     engine validates it names a live user turn on the CURRENT context path
 *     before branching, which is authoritative and side-steps any client-side
 *     ordinal drift.
 *   - ORDINAL FALLBACK: the row is not found (the iOS-initiated path, where
 *     the target was rendered from an optimistic UUID the desktop store
 *     never minted) or is found but still carries only the desktop's own
 *     optimistic `msg-N` id (a fresh, not-yet-confirmed bubble — including
 *     one the engine already rejected or never received). Falls back to the
 *     Nth `role==='user'` message given by `userTurnIndex`, which the engine
 *     resolves the same way it always has.
 *
 * Why user-turn ordinal as the fallback (not raw index): rewind only ever
 * targets a user turn. Counting user turns is invariant to tool/assistant
 * interleaving and to the optimistic-UUID id mismatch, so both sides agree on
 * it. The invariant this relies on is that the desktop's inst.messages and
 * the iOS-rendered instance list hold the same user-turn sequence at rewind
 * time — which holds because an iOS-originated engine prompt drives the
 * desktop renderer's submitEnginePrompt optimistic insert (via
 * processIncomingPrompt → REMOTE_ENGINE_PROMPT). The store test
 * (engine-slice-rewind.test.ts) pins Nth-user-message resolution against
 * interleaved tool/assistant rows to lock this.
 */

import type { StoreSet, StoreGet, State } from '../session-store-types'
import { lastPendingCardTool } from '../../../shared/pending-card'
import { stageableAttachments } from '../../../shared/staged-attachments'
import { reconcileChartsForBranch } from '../../lib/chart-reconcile-request'
import { rDebug, rInfo, rWarn, rError } from '../../rendererLogger'

/**
 * A durable engine entry id is never one of the desktop's own optimistic
 * `msg-N` ids (see nextMsgId in session-store-helpers.ts) — every
 * engine-confirmed row (run-opening turn re-keyed by `user_turn_persisted`,
 * a delivered steer re-keyed by `steer_injected`, or any history-loaded row)
 * carries the engine's own hex entry id instead. This is the exact
 * discriminator the transactional rewind uses to decide whether it can send
 * the row's own id as `entryId` or must fall back to the ordinal.
 */
function isDurableEntryId(id: string): boolean {
  return !id.startsWith('msg-')
}

export function createEngineRewindActions(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    rewindEngineInstance: async (tabId, instanceId, messageId, userTurnIndex) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) {
        rWarn('engine.rewind', 'rewind: tab not found', { tab_id: tabId.slice(0, 8) })
        return { ok: false, error: 'tab not found' }
      }
      const pane = get().conversationPanes.get(tabId)
      if (!pane) {
        rWarn('engine.rewind', 'rewind: pane not found', { tab_id: tabId.slice(0, 8) })
        return { ok: false, error: 'pane not found' }
      }
      const inst = pane.instances.find((i) => i.id === instanceId)
      if (!inst) {
        rWarn('engine.rewind', 'rewind: instance not found', { tab_id: tabId.slice(0, 8), instance_id: instanceId })
        return { ok: false, error: 'instance not found' }
      }

      // Resolve the rewind point. Path 1: id match (desktop-initiated rewind,
      // where messageId is present in inst.messages — either a nextMsgId()
      // optimistic value, or a durable engine entry id from a prior re-key).
      let idx = inst.messages.findIndex((m) => m.id === messageId)
      let exactEntryId: string | undefined
      if (idx >= 0) {
        const row = inst.messages[idx]
        if (isDurableEntryId(row.id)) {
          exactEntryId = row.id
          rDebug('engine.rewind', 'rewind: resolved by id, durable entry id available', { message_id: messageId, idx })
        } else {
          rDebug('engine.rewind', 'rewind: resolved by id, optimistic id only', { message_id: messageId, idx })
        }
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
          const row = inst.messages[idx]
          if (isDurableEntryId(row.id)) exactEntryId = row.id
          rDebug('engine.rewind', 'rewind: resolved by user turn index', { user_turn_index: userTurnIndex, idx, message_id: messageId, has_durable_entry_id: exactEntryId != null })
        } else {
          rWarn('engine.rewind', 'rewind: user turn index out of range', { user_turn_index: userTurnIndex, tab_id: tabId.slice(0, 8), instance_id: instanceId })
          return { ok: false, error: 'user turn index out of range' }
        }
      } else {
        rWarn('engine.rewind', 'rewind: message not found', { tab_id: tabId.slice(0, 8), instance_id: instanceId, message_id: messageId })
        return { ok: false, error: 'message not found' }
      }

      const targetMessage = inst.messages[idx]
      const key = tabId

      // Count the user rows before the target for the ordinal fallback — the
      // same Nth-user-turn the engine's flattenEntries produces from the same
      // entries, so both sides agree (the invariant the store test pins
      // against interleaved tool/assistant rows). Computed unconditionally
      // (cheap) so it is ready as the fallback even when exactEntryId resolved.
      let userTurnOrdinal = 0
      for (let i = 0; i < idx; i++) {
        if (inst.messages[i].role === 'user') userTurnOrdinal++
      }

      rInfo('engine.rewind', 'rewind: attempting', {
        tab_id: key,
        msg_idx: idx,
        user_turn_ordinal: userTurnOrdinal,
        exact_entry_id: exactEntryId ?? '',
        total_msgs: inst.messages.length,
        keep_msgs: idx,
        target_msg_len: targetMessage.content.length,
      })

      // TRANSACTIONAL GATE: call the engine FIRST. Nothing below this line
      // runs until the engine confirms the branch succeeded — a rejected
      // rewind (unknown/foreign-branch/non-user target) must leave every
      // client's transcript untouched, never partially truncated.
      let result: { ok: boolean; error?: string }
      try {
        result = await window.ion.engineRewind(key, exactEntryId ? { entryId: exactEntryId } : { userTurnIndex: userTurnOrdinal })
      } catch (err) {
        rError('engine.rewind', 'rewind: engine rewind invoke failed', { tab_id: key, error: (err as Error).message })
        return { ok: false, error: (err as Error).message }
      }
      if (!result.ok) {
        rError('engine.rewind', 'rewind: engine rewind rejected', { tab_id: key, exact_entry_id: exactEntryId ?? '', user_turn_ordinal: userTurnOrdinal, error: result.error ?? 'unknown' })
        return result
      }
      rInfo('engine.rewind', 'rewind: engine branched to before turn', { tab_id: key, exact_entry_id: exactEntryId ?? '', user_turn_ordinal: userTurnOrdinal })

      const rewoundMessages = inst.messages.slice(0, idx)

      // Restore permissionDenied from the last tool message in the truncated
      // history, mirroring the same pending-card rule every rewind uses.
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

      // The rewound turn's own attachments, narrowed to what the input bar's
      // tray can hold (a plan pointer is a product of the run, not something
      // the user staged — see shared/staged-attachments.ts).
      const restagedAttachments = stageableAttachments(targetMessage.attachments)
      if (restagedAttachments.length > 0) {
        rInfo('engine.rewind', 'rewind: restaging turn attachments', { tab_id: key, count: restagedAttachments.length })
      }

      const panes = new Map(get().conversationPanes)
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
      engineWorkingMessages.delete(key)
      engineNotifications.delete(key)
      engineDialogs.delete(key)
      enginePinnedPrompt.delete(key)

      set((state) => ({
        conversationPanes: panes,
        engineWorkingMessages,
        engineNotifications,
        engineDialogs,
        enginePinnedPrompt,
        // Set pendingInput on the parent TabState so InputBar pre-fills
        // immediately after the confirmed transactional rewind. The turn's
        // attachments go back into the staging tray with it — restoring the
        // text alone left an image-bearing turn un-resendable, because the
        // bytes were only reachable through the message row the rewind just
        // truncated away.
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, pendingInput: targetMessage.content, attachments: restagedAttachments }
            : t
        ),
      }))

      // Bring the durable chart index back onto this branch BEFORE the history
      // broadcast. A rewind past a chart revision leaves the persisted record
      // and the attachments row naming a revision this branch abandoned, while
      // the transcript (derived live from the visible messages) correctly shows
      // the older card — the panel then offers a jump to a revision the
      // operator cannot reach. Reconciling here, inside the confirmed-success
      // branch, means a REFUSED rewind never touches the index.
      reconcileChartsForBranch(tabId, tab.conversationId, rewoundMessages)

      // Broadcast the SAME committed truncation to every connected surface.
      // engineBroadcastHistory (main process) reads this store's now-truncated
      // inst.messages back out and fans it to Studio (direct push, allowlisted
      // in check-studio-parity.sh) and iOS (desktop_conversation_history) in
      // one call — both fire only after the engine confirmed success above, so
      // neither client ever sees a truncation the engine refused.
      window.ion.engineBroadcastHistory(tabId, instanceId).then(() => {
        rDebug('engine.rewind', 'rewind: broadcast truncated history', { tab_id: key })
      }).catch((err: any) => {
        rError('engine.rewind', 'rewind: broadcast failed', { tab_id: key, error: err.message })
      })

      return {
        ok: true,
        prefill: {
          text: targetMessage.content,
          attachments: restagedAttachments,
        },
      }
    },
  }
}
