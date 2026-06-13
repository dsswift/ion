import type { Message, AgentStateUpdate, ConversationInstance, EngineInstance } from '../../shared/types'
import type { PersistedTab } from '../../shared/types-persistence'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { isExtensionErrorMessage } from '../stores/session-store-persistence'

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Restore an engine tab and all its per-instance state from a persisted
 * `PersistedTab` snapshot. Extracted from `useTabRestoration.ts` to
 * keep that file under the 600-line cap.
 *
 * Inputs:
 *   - `st`: the persisted tab record
 *   - `restoredTabIds`: the accumulator used by the caller to track
 *     which tabs were created so historical-message loading can
 *     iterate them later. Updated in-place.
 *   - `tabIndex`: the index of this tab in the persisted array (the
 *     caller uses this to associate the new tabId back to the
 *     original position so `saved.activeTabIndex` works).
 *
 * Side effects:
 *   - Calls `createEngineTab` on the session store (synchronous).
 *   - Performs a single atomic `setState` to seed enginePanes with
 *     fully-populated ConversationInstance fields on each instance.
 *   - Issues async `window.ion.engineStart` calls per instance (the
 *     returned promises are not awaited — engines start in parallel).
 *
 * Returns the newly-created `tabId` so callers can link it.
 */
export function restoreEngineTab(st: PersistedTab, restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }>, tabIndex: number): string {
  const tabId = useSessionStore.getState().createEngineTab(st.workingDirectory, st.engineProfileId || undefined)
  restoredTabIds.push({ tabId, sessionId: null, index: tabIndex })

  // Build all engine state before any setState call to avoid
  // intermediate renders where EngineView sees no instances
  // (its auto-create effect would fire, causing duplicate sessions
  // and cascading re-renders → React error #310).
  //
  // All per-instance state is collected into local Maps here (keyed by
  // instanceId for easy lookup in populatedInstances below) and then
  // written directly onto each EngineInstance as ConversationInstance
  // fields. The 8 legacy Maps on the session store are no longer set
  // from this function — instance fields are the canonical source.
  const restoredPanes = new Map(useSessionStore.getState().enginePanes)

  // Per-instance data — keyed by instanceId (not compound tabId:instanceId).
  const instanceMessages = new Map<string, Message[]>()
  const instanceAgentStates = new Map<string, AgentStateUpdate[]>()
  const instanceDraftInputs = new Map<string, string>()
  // Per-engine-instance pending denials. We deliberately do NOT
  // carry the legacy parent-level `st.permissionDenied` forward
  // for engine tabs — that field was written by the old slice
  // and would show a stale parent-card on every sibling. The
  // engine's reconcile handshake will repopulate the denial
  // per-instance authoritatively on the next engine_status.
  const instancePermissionDenied = new Map<string, { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> }>()
  // Per-engine-instance conversation IDs. Seeded from the
  // persisted `engineSessionIds` so the engine restart can
  // pass the correct sessionId per instance (otherwise three
  // instances under the same tab all try to resume
  // `st.conversationId`, which is the parent tab's single ID
  // — a pre-existing bug). Also lets
  // useEnginePermissionDenialBackfill locate the right
  // conversation file immediately at startup instead of
  // waiting for engine_status to populate the entry.
  const instanceConversationIds = new Map<string, string[]>()
  const instanceModelOverrides = new Map<string, string>()
  const instancePermissionModes = new Map<string, 'auto' | 'plan'>()
  const instanceForkedChains = new Map<string, string[]>()

  if (st.engineInstances && st.engineInstances.length > 0) {
    if (st.engineMessages) {
      for (const inst of st.engineInstances) {
        const saved = st.engineMessages[inst.id]?.filter(
          (m) => !isExtensionErrorMessage({ role: m.role || '', content: m.content || '' }),
        )
        if (saved && saved.length > 0) {
          instanceMessages.set(inst.id, saved.map((m) => ({
            id: crypto.randomUUID(),
            role: m.role as Message['role'],
            content: m.content || '',
            toolName: m.toolName,
            toolId: m.toolId,
            toolInput: m.toolInput,
            toolStatus: m.toolStatus as Message['toolStatus'],
            timestamp: m.timestamp,
            dedupKey: m.dedupKey,
          })))
        }
      }
    }

    if (st.engineAgentStates) {
      for (const inst of st.engineInstances) {
        const saved = st.engineAgentStates[inst.id]
        if (saved && saved.length > 0) {
          instanceAgentStates.set(inst.id, saved.map((a) => ({
            name: a.name,
            ...(a.id ? { id: a.id } : {}),
            status: (a.status === 'running' ? 'done' : a.status) as AgentStateUpdate['status'],
            metadata: a.metadata,
          })))
        }
      }
    }

    if (st.engineDrafts) {
      for (const inst of st.engineInstances) {
        const d = st.engineDrafts[inst.id]
        if (d && d.length > 0) {
          instanceDraftInputs.set(inst.id, d)
          console.log(`[restore] engine draft for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} len=${d.length}`)
        }
      }
    }

    if (st.engineDenials) {
      for (const inst of st.engineInstances) {
        const d = st.engineDenials[inst.id]
        if (d && d.tools && d.tools.length > 0) {
          instancePermissionDenied.set(inst.id, { tools: d.tools })
          console.log(`[restore] engine denial for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} tools=${d.tools.map((t) => t.toolName).join(',')}`)
        }
      }
    }

    // Seed per-instance conversation IDs from persistence.
    // engine_status will append additional IDs as the session
    // runs; we only need the most recent one here so backfill
    // can locate the conversation file.
    if (st.engineSessionIds) {
      for (const inst of st.engineInstances) {
        const sid = st.engineSessionIds[inst.id]
        if (sid) {
          instanceConversationIds.set(inst.id, [sid])
        }
      }
    }

    if (st.engineModelOverrides) {
      for (const inst of st.engineInstances) {
        const m = st.engineModelOverrides[inst.id]
        if (m) {
          instanceModelOverrides.set(inst.id, m)
          console.log(`[restore] engine model override for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} model=${m}`)
        }
      }
    }

    if (st.enginePermissionModes) {
      for (const inst of st.engineInstances) {
        const m = st.enginePermissionModes[inst.id]
        if (m) {
          instancePermissionModes.set(inst.id, m)
          console.log(`[restore] engine permission mode for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} mode=${m}`)
        }
      }
    } else if (st.permissionMode === 'plan') {
      // Back-compat: old persisted state had a single permissionMode on the parent
      // tab that was applied to all instances. If that was 'plan', seed all instances
      // with 'plan' so the restored state matches what the user last saw.
      for (const inst of st.engineInstances) {
        instancePermissionModes.set(inst.id, 'plan')
      }
    }

    if (st.engineForkedFromConversationIds) {
      for (const inst of st.engineInstances) {
        const chain = st.engineForkedFromConversationIds[inst.id]
        if (chain && chain.length > 0) {
          instanceForkedChains.set(inst.id, chain)
        }
      }
    }

    // Fallback: synthesize a denial from the last tool message in
    // each instance's persisted engineMessages when the engine
    // hasn't yet replayed a permissionDenials entry for it.
    //
    // Why this matters: the engine's reconcile_state only re-emits
    // `pendingDenials` from `lastPermissionDenials` in memory. When
    // the engine restarts (or never had the denial recorded), that
    // slice is empty and the desktop loses the card even though
    // the conversation file shows the assistant's final
    // AskUserQuestion / ExitPlanMode call. Mirrors the CLI path
    // (in useTabRestoration.ts) which does the same scan over
    // historical messages — engine tabs need this too because they
    // don't route through the CLI's historicalSessionIds replay.
    //
    // We only synthesize when:
    //   - the instance has no entry in instancePermissionDenied
    //     (engineDenials already authoritative if present), AND
    //   - the last persisted message with a toolName is
    //     AskUserQuestion or ExitPlanMode.
    //
    // The synthetic entry's toolInput is parsed from the persisted
    // message's `toolInput` (a JSON string captured by the engine_tool_update
    // slice handler). For pre-feature persisted data that lacks
    // toolInput, the entry is created with toolInput=undefined; the
    // useEnginePermissionDenialBackfill hook then loads the matching
    // conversation file to enrich the toolInput from disk.
    if (st.engineMessages) {
      for (const inst of st.engineInstances) {
        if (instancePermissionDenied.get(inst.id)) continue
        const msgs = st.engineMessages[inst.id]
        if (!msgs || msgs.length === 0) continue
        // Find the most recent tool message.
        const lastTool = [...msgs].reverse().find((m) => m.toolName)
        if (!lastTool) continue
        if (lastTool.toolName !== 'AskUserQuestion' && lastTool.toolName !== 'ExitPlanMode') continue
        instancePermissionDenied.set(inst.id, {
          tools: [{
            toolName: lastTool.toolName,
            toolUseId: lastTool.toolId || 'restored',
            toolInput: parseToolInput(lastTool.toolInput),
          }],
        })
        console.log(`[restore] engine denial synthesized from history for ${tabId.slice(0, 8)}:${inst.id.slice(0, 8)} tool=${lastTool.toolName} toolId=${(lastTool.toolId || 'none').slice(0, 16)} hasInput=${lastTool.toolInput ? 'yes' : 'no'}`)
      }
    }

    // Build pane instances with fully-populated ConversationInstance fields.
    // All per-instance data was collected into the local Maps above.
    // Components that read from instance fields see correct initial values
    // without waiting for the first engine event (issue #203).
    const populatedInstances: Array<EngineInstance & ConversationInstance> = st.engineInstances.map((inst) => ({
      ...inst,
      messages: instanceMessages.get(inst.id) || [],
      modelOverride: instanceModelOverrides.get(inst.id) || null,
      permissionMode: (instancePermissionModes.get(inst.id) || 'auto') as 'auto' | 'plan',
      permissionDenied: instancePermissionDenied.get(inst.id) || null,
      conversationIds: instanceConversationIds.get(inst.id) || [],
      draftInput: instanceDraftInputs.get(inst.id) || '',
      agentStates: instanceAgentStates.get(inst.id) || [],
      statusFields: null,   // populated on first engine_status event
      planFilePath: null,   // populated on first engine_plan_mode_changed event
      forkedFromConversationIds: instanceForkedChains.get(inst.id) || null,
    }))
    restoredPanes.set(tabId, {
      instances: populatedInstances,
      activeInstanceId: st.engineInstances[0].id,
    })
  }

  // Single atomic setState: tab metadata + enginePanes with fully-populated instances.
  // Instance fields (messages, agentStates, permissionDenied, etc.) are written onto
  // each instance directly — the legacy per-Map keys are not seeded here.
  useSessionStore.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            customTitle: st.customTitle || null,
            pillColor: st.pillColor || null,
            groupId: st.groupId || null,
            groupPinned: st.groupPinned ?? false,
            modelOverride: st.modelOverride || null,
            conversationId: st.conversationId || null,
            draftInput: st.draftInput ?? '',
            lastMessagePreview: st.lastMessagePreview || null,
            lastEventAt: st.lastEventAt ?? null,
            // Keep tab.permissionMode at 'auto' for engine tabs — per-instance
            // modes live on each instance in enginePanes. The parent tab's
            // permissionMode is only meaningful for CLI tabs.
            permissionMode: 'auto',
            // NB: deliberately NOT restoring st.permissionDenied
            // for engine tabs — legacy field, now superseded by
            // instance.permissionDenied. See comment above.
          }
        : t
    ),
    enginePanes: restoredPanes,
  }))
  if (st.draftInput) console.log(`[restore] draft for engine tab ${tabId.slice(0, 8)} len=${st.draftInput.length}`)

  // Start engine processes (state is fully set up)
  if (st.engineInstances && st.engineInstances.length > 0) {
    const { engineProfiles } = usePreferencesStore.getState()
    const profile = st.engineProfileId ? engineProfiles.find((p) => p.id === st.engineProfileId) : null
    if (profile) {
      for (const inst of st.engineInstances) {
        const key = `${tabId}:${inst.id}`
        // Prefer the per-instance sessionId from
        // engineSessionIds (most recent conversation file for
        // this instance). Fall back to the parent
        // tab.conversationId only for back-compat with old
        // persisted states that pre-date the per-instance
        // serialization — in that case all instances will try
        // to share one conversation, which is the legacy
        // behavior; new persisted states avoid this collision.
        const instSessionId = st.engineSessionIds?.[inst.id] || st.conversationId || ''
        window.ion.engineStart(key, {
          profileId: profile.id,
          extensions: profile.extensions,
          workingDirectory: st.workingDirectory,
          ...(instSessionId ? { sessionId: instSessionId } : {}),
        }).then(() => {
          // Sync plan mode to the engine after the session exists.
          // Read from the per-instance permissionMode on the pane instance
          // (seeded into populatedInstances above). The engine creates
          // fresh sessions with planMode=false; without this sync, a restored
          // plan-mode instance loses its engine plan mode state until the next
          // submitEnginePrompt fires.
          const pane = useSessionStore.getState().enginePanes.get(tabId)
          const restoredInst = pane?.instances.find((i) => i.id === inst.id)
          if (restoredInst?.permissionMode === 'plan') {
            console.log(`[restore] syncing plan mode to engine for ${key}`)
            window.ion.engineSetPlanMode(key, true)
          }
        }).catch((err: { message?: string }) => {
          console.error(`[restore] engine start failed for ${key}: ${err.message}`)
        })
      }
    }
  }

  return tabId
}
