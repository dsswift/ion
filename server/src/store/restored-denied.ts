import { lastPendingCardTool, type PendingCardMessage } from '@ion/shared/pending-card'
import { rWarn } from './rendererLogger'
import { rehydrateQuestionsFromRows } from '../questions/questions-wiring'

/**
 * Shared pending-card restoration, extracted from resume-slice.ts so BOTH the
 * slice and the lazy-hydration module (resume-slice-hydration.ts) apply the
 * identical rule without either importing the other. The seam is one-way: this
 * module imports nothing from the store slices.
 */

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
export function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Build a restored `permissionDenied` entry from a message history using the
 * shared pending-card rule (returns null when no card should be restored —
 * e.g. a trailing /clear divider or user message dismissed it). Single seam so
 * every fork/resume/rewind path applies the identical rule.
 */
export function buildRestoredDenied(
  messages: readonly PendingCardMessage[],
): { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null {
  const found = lastPendingCardTool(messages)
  if (!found) return null
  return { tools: [{ toolName: found.toolName, toolUseId: found.toolId || 'restored', toolInput: parseToolInput(found.toolInput) }] }
}

/**
 * Hand a restored transcript to main so a parked Guided Questions round is
 * rebuilt from it.
 *
 * Called at the same seam as `buildRestoredDenied` — both answer "does this
 * conversation still owe the operator an answer?", one for the single-question
 * card and one for the questions panel, from the same message list. Keeping
 * them together is deliberate: if only one runs on a restore path, the tab dot
 * and the panel disagree about whether the operator owes an answer.
 *
 * Fire-and-forget: the coordinator decides (a live workflow always wins,
 * since it may hold a typed draft), and a failed rehydrate must never block a
 * conversation from opening.
 *
 * In-process call: the desktop's old `window.ion.questionsRehydrate` IPC
 * round-trip had no server-side equivalent to preserve — `@ion/server`'s
 * `questions-wiring.ts` already exposes `rehydrateQuestionsFromRows`, the same
 * function the desktop's `ipcMain.handle(QUESTIONS_REHYDRATE, ...)` called,
 * so this calls it directly rather than reaching for a bridge that does not
 * exist headless (see chart-reconcile-request.ts for the same pattern).
 */
export function rehydrateQuestionsFromMessages(
  tabId: string,
  messages: readonly PendingCardMessage[],
): void {
  try {
    // Only the fields the scan reads. Passing whole Message objects would
    // carry attachments and rendered content into the scan for nothing.
    rehydrateQuestionsFromRows(
      tabId,
      messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : undefined,
        toolName: m.toolName,
        toolId: m.toolId,
        toolInput: m.toolInput,
        injectionKind: (m as { injectionKind?: string }).injectionKind,
        machineAuthored: (m as { machineAuthored?: boolean }).machineAuthored,
      })),
    )
  } catch (err) {
    // Defensive: restoring a conversation must never fail because this
    // best-effort call errored (e.g. the coordinator has not wired up yet
    // during early boot) — a throw here would abort the hydration that owns
    // the operator's actual transcript.
    rWarn('session.restore', 'questions rehydrate failed', { tab_id: tabId.slice(0, 8), error: String(err) })
  }
}
