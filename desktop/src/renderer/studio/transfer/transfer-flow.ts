/**
 * transfer-flow — the pure three-step orchestration behind the Desktop
 * Transfer verb: export the source tab to a local temp file, import that
 * file into the target environment, then delete the source once the target
 * has verified what it received. Takes its host/action dependencies as
 * plain function parameters (not `StudioHost` directly) so
 * `transfer-flow.test.ts` can exercise the flow against two fake
 * environments with no Electron/IPC boundary involved.
 *
 * A transfer is a move: a conversation lives on one host at a time. The
 * source is not marked, sealed, or kept read-only — it is removed, so there
 * is never a second copy to reconcile, and never a question about which one
 * is real. Nothing is deleted until the destination has re-hashed every
 * file it wrote and matched it against the digests the source recorded
 * (`server/src/transfer/entries.ts`), so an interrupted transfer always
 * fails with the original still intact.
 */
import type { ExportFileOptions, ExportFileResult, ImportFileResult, TransferLanding } from '@ion/shared/types-transfer'

/** `moving` is the single step of a move within one machine (`runLocalMove`). */
export type TransferStep = 'exporting' | 'importing' | 'removing' | 'moving'

export interface TransferRefusal {
  code: string
  message: string
}

export interface TransferFlowSuccess {
  ok: true
  targetEnvironmentId: string
  /**
   * The destination tab id, when known. Only a fresh export -> import ->
   * remove run learns this (from the import result); `retryRemoval` alone
   * has no way to recover it, so a retried removal can finish the move but
   * cannot offer "Open there" a specific tab to select.
   */
  targetTabId?: string
  /** Where the conversation lives now, when the step that moved it said (a move within one machine does). */
  workingDirectory?: string
}

export interface TransferFlowFailure {
  ok: false
  step: TransferStep
  refusal: TransferRefusal
}

export type TransferFlowResult = TransferFlowSuccess | TransferFlowFailure

export interface TransferFlowDeps {
  exportToFile(environmentId: string, tabId: string, targetEnvironmentId: string, options?: ExportFileOptions): Promise<ExportFileResult>
  importFromFile(environmentId: string, tabId: string, filePath: string, landing?: TransferLanding | null): Promise<ImportFileResult>
  action(environmentId: string, name: string, args?: unknown[]): Promise<unknown>
}

function refusalFromError(err: unknown): TransferRefusal {
  const code = err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : 'failed'
  return { code, message: err instanceof Error ? err.message : String(err) }
}

/**
 * Runs the export -> import -> remove sequence for one tab. Stops at the first
 * failing step, tagging the result with which step failed so the dialog can
 * offer a step-scoped Retry (spec 15 §Requirements: "errors rendered as
 * failures with Retry for the failed step").
 *
 * One import refusal is not a stopping failure: `conversation_exists` means
 * the archive already landed on the target from an earlier attempt -- a
 * client that closed mid-import, or a retried call after a partial
 * transfer, hits this exact path. The flow proceeds to the removal without
 * a destination tab id, since only a successful import (not this recovered
 * case) reports one.
 */
export async function runTransfer(
  sourceEnvironmentId: string,
  tabId: string,
  targetEnvironmentId: string,
  deps: TransferFlowDeps,
  exportOptions: ExportFileOptions = {},
  /** Where a conversation arriving without its worktree lands on the destination; null when it brings its worktree, which lands in the checkout the import creates. */
  landing: TransferLanding | null = null,
  /** True only for the last conversation of a whole-worktree move: the source checkout is retired with it. */
  retireWorktree = false,
): Promise<TransferFlowResult> {
  const exportResult = await deps.exportToFile(sourceEnvironmentId, tabId, targetEnvironmentId, exportOptions)
  if (!exportResult.ok) return { ok: false, step: 'exporting', refusal: exportResult.refusal }

  const importResult = await deps.importFromFile(targetEnvironmentId, tabId, exportResult.filePath, landing)
  const alreadyLanded = !importResult.ok && importResult.refusal.code === 'conversation_exists'
  if (!importResult.ok && !alreadyLanded) return { ok: false, step: 'importing', refusal: importResult.refusal }

  try {
    await deps.action(sourceEnvironmentId, 'transfer.remove', [{ tabId, targetEnvironmentId, retireWorktree }])
  } catch (err) {
    return { ok: false, step: 'removing', refusal: refusalFromError(err) }
  }

  return importResult.ok ? { ok: true, targetEnvironmentId, targetTabId: importResult.tabId } : { ok: true, targetEnvironmentId }
}

export interface WorktreeMoveResult {
  ok: boolean
  targetEnvironmentId: string
  /** Tabs whose export -> import -> remove completed, in order. */
  moved: string[]
  /** The destination tab of the FIRST tab moved, when the import reported one. */
  targetTabId?: string
  /** Set when a tab failed; every tab before it in `moved` is already on the destination. */
  failed?: { tabId: string; step: TransferStep; refusal: TransferRefusal }
}

/**
 * Moves a worktree: every conversation in it, one after another, through
 * the same export -> import -> remove each. A worktree has one home at a
 * time, so moving one conversation and leaving its siblings here would put
 * two copies of one branch on two machines; the dialog names the siblings
 * and this runs them all. The checkout itself is removed with the last
 * conversation that held it. The first tab's export carries the
 * bundle the destination needs; each later import finds the checkout
 * already current and reuses it. Stops at the first failure and reports
 * which tabs are already across, so a retry resumes rather than repeats.
 */
export async function runWorktreeMove(
  sourceEnvironmentId: string,
  tabIds: readonly string[],
  targetEnvironmentId: string,
  deps: TransferFlowDeps,
  exportOptions: ExportFileOptions = {},
  /** Where a conversation leaving without its worktree lands; null for a whole-worktree move. */
  landing: TransferLanding | null = null,
): Promise<WorktreeMoveResult> {
  const moved: string[] = []
  let targetTabId: string | undefined
  for (const [index, tabId] of tabIds.entries()) {
    // The checkout goes with the LAST conversation. Every earlier one still
    // needs it: each conversation's export packages the worktree again.
    const isLast = index === tabIds.length - 1
    const result = await runTransfer(sourceEnvironmentId, tabId, targetEnvironmentId, deps, exportOptions, landing, isLast)
    if (!result.ok) {
      return { ok: false, targetEnvironmentId, moved, targetTabId, failed: { tabId, step: result.step, refusal: result.refusal } }
    }
    moved.push(tabId)
    if (targetTabId === undefined && result.targetTabId) targetTabId = result.targetTabId
  }
  return { ok: true, targetEnvironmentId, moved, targetTabId }
}

/**
 * Retries only the removal, for a tab left `sealPending` by a prior
 * `runTransfer` whose import landed but whose source was never deleted --
 * a client that crashed between the two. `transfer.remove` is idempotent
 * (a source already gone answers ok) and refuses any tab that is not
 * mid-transfer, so calling it again is safe.
 *
 * It never retires a worktree. The pill that offers this retry knows one
 * conversation, not whether it was the last of a worktree move, so a
 * checkout left behind by an interrupted worktree move stays until it is
 * retired deliberately — a leftover, never a loss.
 */
export async function retryRemoval(
  sourceEnvironmentId: string,
  tabId: string,
  targetEnvironmentId: string,
  deps: Pick<TransferFlowDeps, 'action'>,
): Promise<TransferFlowResult> {
  try {
    await deps.action(sourceEnvironmentId, 'transfer.remove', [{ tabId, targetEnvironmentId }])
  } catch (err) {
    return { ok: false, step: 'removing', refusal: refusalFromError(err) }
  }
  return { ok: true, targetEnvironmentId }
}

/**
 * Moves a conversation to another checkout or worktree on the machine it
 * already lives on. Nothing is exported or deleted: `transfer.relocate`
 * repoints the tab and its live session together, so this is one step that
 * either happened or did not.
 */
export async function runLocalMove(
  environmentId: string,
  tabId: string,
  landing: TransferLanding,
  deps: Pick<TransferFlowDeps, 'action'>,
): Promise<TransferFlowResult> {
  try {
    const value = (await deps.action(environmentId, 'transfer.relocate', [{ tabId, landing }])) as { workingDirectory?: string } | undefined
    return { ok: true, targetEnvironmentId: environmentId, targetTabId: tabId, ...(value?.workingDirectory ? { workingDirectory: value.workingDirectory } : {}) }
  } catch (err) {
    return { ok: false, step: 'moving', refusal: refusalFromError(err) }
  }
}
