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

import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { lastPendingCardTool } from '../../../shared/pending-card'

export function createEngineRewindActions(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    rewindEngineInstance: (tabId, instanceId, messageId, userTurnIndex) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) {
        console.warn(`[engine] rewindEngineInstance: tab not found tabId=${tabId.slice(0, 8)}`)
        return
      }
      const panes = new Map(get().conversationPanes)
      const pane = panes.get(tabId)
      if (!pane) {
        console.warn(`[engine] rewindEngineInstance: pane not found tabId=${tabId.slice(0, 8)}`)
        return
      }
      const inst = pane.instances.find((i) => i.id === instanceId)
      if (!inst) {
        console.warn(`[engine] rewindEngineInstance: instance not found tabId=${tabId.slice(0, 8)} instanceId=${instanceId}`)
        return
      }

      // Resolve the rewind point. Path 1: id match (desktop-initiated rewind,
      // where messageId is a nextMsgId() value present in inst.messages).
      let idx = inst.messages.findIndex((m) => m.id === messageId)
      if (idx >= 0) {
        console.log(`[engine] rewindEngineInstance: resolved by id messageId=${messageId} idx=${idx}`)
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
          console.log(`[engine] rewindEngineInstance: resolved by userTurnIndex=${userTurnIndex} idx=${idx} (id ${messageId} not found)`)
        } else {
          console.warn(`[engine] rewindEngineInstance: userTurnIndex=${userTurnIndex} out of range (only ${userCount + 1} user messages) tabId=${tabId.slice(0, 8)} instanceId=${instanceId}`)
          return
        }
      } else {
        console.warn(`[engine] rewindEngineInstance: message not found tabId=${tabId.slice(0, 8)} instanceId=${instanceId} messageId=${messageId} (no userTurnIndex fallback)`)
        return
      }

      const targetMessage = inst.messages[idx]
      const key = `${tabId}:${instanceId}`
      const priorConvIds = inst.conversationIds.length > 0 ? [...inst.conversationIds] : null
      console.log(`[engine] rewindEngineInstance: key=${key} msgIdx=${idx} totalMsgs=${inst.messages.length} keepMsgs=${idx} priorConvIds=${JSON.stringify(priorConvIds)} targetMsgLen=${targetMessage.content.length}`)

      // Stop the engine session completely (not just abort the current run).
      // A rewind must start a fresh conversation — aborting would leave the
      // old conversation file intact and the next send_prompt would append to
      // it, creating a confusing state where the engine has full pre-rewind
      // history but the desktop shows truncated messages.
      window.ion.engineStop(key).then(() => {
        console.log(`[engine] rewindEngineInstance: session stopped key=${key}, starting fresh session`)
        // Start a fresh session with the same key. No sessionId is passed,
        // so the engine allocates a new conversation file. The prior context
        // is injected as appendSystemPrompt on the next prompt (see
        // engine-slice-submit.ts fork context injection).
        const { engineProfiles } = usePreferencesStore.getState()
        const profile = tab.engineProfileId ? engineProfiles.find((p) => p.id === tab.engineProfileId) : null
        window.ion.engineStart(key, {
          profileId: profile?.id || '',
          extensions: profile?.extensions || [],
          workingDirectory: tab.workingDirectory,
        }).then(() => {
          console.log(`[engine] rewindEngineInstance: fresh session started key=${key} profile=${profile?.id || 'none'}`)
          // Broadcast the truncated history to all connected remote devices so
          // iOS replaces its now-stale message list immediately, instead of
          // waiting for a sub-tab switch to re-issue load_engine_conversation.
          // The renderer store already holds the truncated inst.messages at
          // this point (the set() below runs synchronously before this resolves).
          window.ion.engineBroadcastHistory(tabId, instanceId).then(() => {
            console.log(`[engine] rewindEngineInstance: broadcast truncated history key=${key}`)
          }).catch((err: any) => {
            console.error(`[engine] rewindEngineInstance: broadcast failed key=${key} err=${err.message}`)
          })
        }).catch((err: any) => {
          console.error(`[engine] rewindEngineInstance: restart failed key=${key} err=${err.message}`)
        })
      }).catch((err: any) => {
        console.error(`[engine] rewindEngineInstance: stop failed key=${key} err=${(err as Error).message}`)
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

      panes.set(tabId, {
        ...pane,
        instances: pane.instances.map((i) => {
          if (i.id !== instanceId) return i
          return {
            ...i,
            messages: rewoundMessages,
            messageCount: rewoundMessages.length,  // keep count in lockstep with truncated history
            modelOverride: i.modelOverride,  // preserve model selection across rewind
            sessionModel: null,  // fresh session reports its model on the next status event
            permissionMode: i.permissionMode, // preserve permission mode across rewind
            permissionDenied: restoredDenied,
            permissionQueue: [],
            conversationIds: [],
            draftInput: targetMessage.content,
            agentStates: [],
            statusFields: null,
            planFilePath: null,
            forkedFromConversationIds: i.conversationIds.length > 0 ? [...i.conversationIds] : null,
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
