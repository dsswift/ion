/**
 * Shared, pure mapper from the engine wire type (`SessionLoadMessage`) to the
 * desktop client-render `Message`. This is the single seam every historical
 * load path (resume-slice.ts, useTabRestoration.ts, and any future consumer)
 * uses so the conversion — including marker-row handling — stays in lockstep.
 *
 * The engine now yields system-role marker rows on historical reload
 * (compaction / plan / steer) discriminated by `SessionLoadMessage.markerKind`.
 * The engine emits structured data, not display strings; this mapper formats
 * the content using the desktop's existing formatters so a reloaded marker is
 * byte-identical to the live-session divider the renderer already produces.
 *
 * Pure (no Electron/IPC binding) → import-safe from both processes. See desktop
 * AGENTS.md § IPC.
 */

import type { Message, SessionLoadMessage } from './types'
import { buildCompactionMarkerContent } from './compaction-marker'
import {
  formatPlanCreatedDivider,
  formatPlanUpdatedDivider,
  formatSteerAppliedDivider,
} from './clear-divider'

/**
 * Convert a marker row (a `SessionLoadMessage` with `markerKind` set) into the
 * display content the renderer expects, mirroring the live-session handlers:
 *
 *   - compaction → `buildCompactionMarkerContent` (event-slice.ts `compacting`)
 *   - plan       → `formatPlanCreatedDivider` / `formatPlanUpdatedDivider`
 *                  (event-slice-plan-mode.ts `plan_file_written`)
 *   - steer      → `formatSteerAppliedDivider` (event-slice.ts `steer_injected`)
 *
 * The marker timestamp drives the divider clock so a reloaded conversation
 * shows the original time, not the reload time. Returns `null` when the row is
 * not a marker or when the compaction marker collapses to a no-op — the caller
 * then treats the row as an ordinary message (or drops the no-op compaction).
 */
export function buildMarkerContent(m: SessionLoadMessage): string | null {
  if (!m.markerKind) return null
  const at = new Date(m.timestamp || Date.now())
  switch (m.markerKind) {
    case 'compaction':
      return buildCompactionMarkerContent({
        summary: m.markerSummary,
        messagesBefore: m.markerMessagesBefore,
        messagesAfter: m.markerMessagesAfter,
        clearedBlocks: m.markerClearedBlocks,
        strategy: m.markerStrategy,
        microOnly: m.markerMicroOnly,
      })
    case 'plan':
      return m.markerPlanOperation === 'updated'
        ? formatPlanUpdatedDivider(at, m.markerPlanSlug)
        : formatPlanCreatedDivider(at, m.markerPlanSlug)
    case 'steer':
      return formatSteerAppliedDivider(at, m.markerMessageLength ?? 0)
    default:
      return null
  }
}

/**
 * Tools whose "error" results are conversational (a declined plan, a question
 * answered "no") rather than failures. The live reducer never marks them
 * failed; history mapping must agree. Mirrors the exemption in
 * event-slice.ts's tool_result handler.
 */
const ERROR_EXEMPT_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion'])

/**
 * Map a single engine `SessionLoadMessage` to a client `Message`, or `null`
 * when the row should be dropped entirely (a no-op compaction marker the engine
 * still persisted — mirrors the live path where `buildCompactionMarkerContent`
 * returning `null` suppresses the marker).
 *
 * Row identity: the engine's canonical row id (`SessionLoadMessage.id` — the
 * persisted entry id, stable across reloads) is used whenever present, so
 * every consumer shares one id-space and repeated hydrations never mint new
 * identities. `makeId` supplies the id only as a degraded fallback for rows
 * from an engine that predates the field.
 */
export function mapSessionMessage(m: SessionLoadMessage, makeId: () => string): Message | null {
  // Tool rows are keyed by the engine tool id — the SAME key the live
  // reducer uses when the tool_call streams in — so a history reload dedups
  // against a live-built tool row. Every other row uses the engine's
  // canonical entry-row id (live assistant/user rows re-key to it at
  // message_end). makeId is the degraded fallback for engines predating ids.
  const rowId = (m.toolName && m.toolId ? m.toolId : m.id) || makeId()
  if (m.markerKind) {
    const content = buildMarkerContent(m)
    // A no-op compaction marker (buildCompactionMarkerContent → null) is
    // dropped, matching the live compacting handler which never pushes it.
    if (content === null) return null
    const msg: Message = {
      id: rowId,
      role: 'system',
      content,
      timestamp: m.timestamp,
    }
    // Carry planFilePath so the plan slug stays clickable after reload, exactly
    // as the live plan_file_written handler does.
    if (m.markerKind === 'plan' && m.markerPlanFilePath) {
      msg.planFilePath = m.markerPlanFilePath
    }
    return msg
  }

  const failed = m.isError && m.toolName && !ERROR_EXEMPT_TOOLS.has(m.toolName)
  return {
    id: rowId,
    role: m.role as Message['role'],
    content: m.content || '',
    toolName: m.toolName,
    toolId: m.toolId,
    toolInput: m.toolInput,
    toolStatus: m.toolName ? (failed ? 'error' : 'completed') : undefined,
    userExecuted: m.userExecuted,
    slashCommand: m.slashCommand,
    slashArgs: m.slashArgs,
    slashSource: m.slashSource,
    attachments: m.attachments,
    timestamp: m.timestamp,
  }
}

/**
 * Map an array of engine history rows to client `Message`s, filtering out
 * internal rows and any dropped marker rows (no-op compactions). Convenience
 * wrapper over `mapSessionMessage` for the common `history.filter(...).map(...)`
 * shape the load paths repeat.
 */
export function mapSessionHistory(
  history: readonly SessionLoadMessage[],
  makeId: () => string,
): Message[] {
  const out: Message[] = []
  for (const m of history) {
    if (m.internal) continue
    const mapped = mapSessionMessage(m, makeId)
    if (mapped) out.push(mapped)
  }
  return out
}
