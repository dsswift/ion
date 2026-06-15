import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

/**
 * Backfill pending AskUserQuestion / ExitPlanMode denials for engine
 * instances from their on-disk conversation files.
 *
 * Why this exists:
 *   Across desktop restarts (and especially upgrades) the engine's
 *   in-memory `lastPermissionDenials` is lost. When the desktop
 *   reattaches and triggers `reconcile_state`, the engine emits
 *   `engine_status` with `pendingDenials=0`. The desktop's persisted
 *   `engineDenials` field is only as fresh as the last successful
 *   serialization; if the previous build hadn't yet written that
 *   field (e.g. immediately after this feature was introduced), the
 *   denial state is gone.
 *
 *   But the assistant's tool_use call IS recorded in the engine
 *   conversation file (`~/.ion/conversations/<sessionId>.jsonl`).
 *   Loading the file and inspecting the last tool_use lets us
 *   reconstruct the denial — including its full `toolInput` (so the
 *   card can render question text and plan content).
 *
 * Trigger:
 *   This effect watches `conversationPanes`. Each time instance.conversationIds
 *   is updated (by engine_status carrying a sessionId after start_session
 *   + reconcile_state), the pane Map identity changes and this subscription
 *   fires. At that point we know:
 *     - the compound key (`${tabId}:${instanceId}`)
 *     - the latest sessionId for this instance (instance.conversationIds.last)
 *     - whether instance.permissionDenied already has live data (no backfill
 *       needed) or a synthesized entry that needs toolInput enrichment.
 *
 * What we read:
 *   `window.ion.loadSession(sessionId)` returns engine messages from
 *   `loadEngineConversationMessages` (see main/session-meta.ts). Each
 *   `role: 'tool'` entry carries `toolName`, `toolId`, and `toolInput`
 *   (JSON string of the tool_use input). We scan from the end and
 *   pick the most recent tool whose `toolName` is AskUserQuestion or
 *   ExitPlanMode that does NOT have a populated `content` (which
 *   would indicate a `tool_result` was already recorded — meaning the
 *   user already answered).
 *
 *   We only WRITE to instance.permissionDenied when:
 *     - no entry exists for the instance, OR
 *     - the existing entry's first tool has `toolInput == null/undefined`
 *       (synthesis from restoration that needs enrichment).
 *
 *   If the backfill finds nothing, we still mark the key as
 *   processed so we don't repeatedly load the same file.
 */
export function useEnginePermissionDenialBackfill(): void {
  useEffect(() => {
    const processedKeys = new Set<string>()

    // Subscribe to conversationPanes. The pane Map identity changes whenever
    // instance.conversationIds is updated (engine_status sets a new sessionId).
    // We iterate all instances across all panes to find newly-resolvable keys.
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.conversationPanes === prev.conversationPanes) return

      for (const [tabId, pane] of state.conversationPanes) {
        for (const inst of pane.instances) {
          const key = `${tabId}:${inst.id}`
          if (processedKeys.has(key)) continue
          const sessionIds = inst.conversationIds
          const sessionId = sessionIds[sessionIds.length - 1]
          if (!sessionId) continue

          const existing = inst.permissionDenied
          // We only enrich EXISTING synthesized entries. If no entry
          // exists, we don't create one from the conversation file —
          // that risks cross-instance contamination when multiple
          // instances share a single legacy parent-tab conversationId
          // (a pre-existing structural bug; see
          // useTabRestoration.ts:engineSessionIds comment).
          //
          // A synthesized entry has `toolInput === undefined` because
          // the messages persistence didn't capture toolInput before
          // this change. A live denial that arrived via engine_status
          // has full toolInput. We only act on the former.
          if (!existing || !existing.tools || existing.tools.length === 0) {
            processedKeys.add(key)
            continue
          }
          if (existing.tools[0]?.toolInput) {
            processedKeys.add(key)
            continue
          }

          // Mark processed BEFORE the async call to prevent re-entry
          // during the await. If the load fails or returns empty, we
          // accept the loss; we won't infinitely retry.
          processedKeys.add(key)
          void backfillForKey(tabId, inst.id, key, sessionId, existing.tools[0].toolName, existing.tools[0].toolUseId)
        }
      }
    })

    return () => {
      unsubscribe()
      processedKeys.clear()
    }
  }, [])
}

/**
 * Load `sessionId`'s conversation file and, if its tail shows an
 * unresolved tool_use matching the synthesized entry's toolName and
 * toolUseId, enrich instance.permissionDenied for `key` with the
 * file's toolInput. Logs both branches so an operator can confirm
 * which keys got backfilled and which didn't via a single grep over
 * `~/.ion/desktop.log`.
 *
 * The `expectedToolName` / `expectedToolUseId` parameters anchor the
 * lookup: when multiple instances share a single conversation file
 * (legacy parent-tab.conversationId leak), we only enrich the key
 * whose synthesized tool_use ID matches the file's tail.
 */
async function backfillForKey(
  tabId: string,
  instanceId: string,
  key: string,
  sessionId: string,
  expectedToolName: string,
  expectedToolUseId: string,
): Promise<void> {
  try {
    const msgs = await window.ion.loadSession(sessionId)
    if (!Array.isArray(msgs) || msgs.length === 0) {
      console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=empty no messages in conversation file`)
      return
    }

    // Walk from the end to find the most recent tool_use of interest.
    // An "unresolved" tool_use is one without a matching tool_result —
    // loadEngineConversationMessages writes the result content into
    // `m.content` when a tool_result is paired up. An empty content
    // string means no result, hence pending.
    //
    // To prevent cross-instance contamination we anchor on the
    // synthesized entry's expectedToolUseId — only enrich when the
    // file's tail matches.
    let candidate: { toolName: string; toolId: string; toolInput: string } | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string; toolName?: string; toolId?: string; toolInput?: string; content?: string }
      if (m.role !== 'tool' || !m.toolName) continue
      // The first tool we encounter walking backward is the last one.
      if (m.toolName !== 'AskUserQuestion' && m.toolName !== 'ExitPlanMode') {
        console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=otherTool last tool was ${m.toolName} — no card to restore`)
        return
      }
      if (m.content && m.content.length > 0) {
        console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=resolved last tool ${m.toolName} already has a result — nothing pending`)
        return
      }
      // Match anchor: tool name OR toolId must agree with the
      // synthesized entry to be sure this file's tail belongs to
      // this instance.
      const idMatch = m.toolId && expectedToolUseId !== 'restored' && m.toolId === expectedToolUseId
      const nameMatch = m.toolName === expectedToolName
      if (!idMatch && !nameMatch) {
        console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=mismatch file tail tool=${m.toolName} toolId=${(m.toolId || '').slice(0, 16)} but expected ${expectedToolName} toolId=${expectedToolUseId.slice(0, 16)}`)
        return
      }
      candidate = {
        toolName: m.toolName,
        toolId: m.toolId || expectedToolUseId,
        toolInput: m.toolInput || '',
      }
      break
    }

    if (!candidate) {
      console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=noToolMessages no tool messages found`)
      return
    }

    // Parse the JSON-string toolInput into a Record for the denial entry.
    // PermissionDeniedCard reads `denial.toolInput` as an object, not a
    // string. parseToolInput in useTabRestoration.ts does the same.
    let parsedInput: Record<string, unknown> | undefined = undefined
    if (candidate.toolInput) {
      try { parsedInput = JSON.parse(candidate.toolInput) } catch { parsedInput = undefined }
    }
    if (!parsedInput) {
      console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=noInput file has tool but no parseable input`)
      return
    }

    const finalCandidate = candidate
    const finalParsedInput = parsedInput
    useSessionStore.setState((state) => {
      const pane = state.conversationPanes.get(tabId)
      if (!pane) return {}
      const idx = pane.instances.findIndex((i) => i.id === instanceId)
      if (idx === -1) return {}
      const existing = pane.instances[idx].permissionDenied
      // Final guard: don't overwrite a live denial that arrived between
      // when we decided to backfill and when the load returned.
      if (!existing || !existing.tools || existing.tools.length === 0) return {}
      if (existing.tools[0]?.toolInput) return {}
      const updatedPanes = new Map(state.conversationPanes)
      const instances = pane.instances.slice()
      instances[idx] = {
        ...instances[idx],
        permissionDenied: {
          tools: [{
            toolName: finalCandidate.toolName,
            toolUseId: finalCandidate.toolId,
            toolInput: finalParsedInput,
          }],
        },
      }
      updatedPanes.set(tabId, { ...pane, instances })
      console.log(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=enriched tool=${finalCandidate.toolName} toolId=${finalCandidate.toolId.slice(0, 16)} inputKeys=${Object.keys(finalParsedInput).join(',')}`)
      return { conversationPanes: updatedPanes }
    })
  } catch (err) {
    console.warn(`[denial-backfill] key=${key} sessionId=${sessionId.slice(0, 20)} branch=error ${err instanceof Error ? err.message : String(err)}`)
  }
}
