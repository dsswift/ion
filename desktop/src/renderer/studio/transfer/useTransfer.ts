/**
 * useTransfer — React state machine over `transfer-flow.ts`'s `runTransfer`
 * (spec 15's Desktop Transfer verb progress card: "exporting (bytes),
 * importing (bytes), sealing; each refusal rendered with its code text").
 *
 * `host.exportToFile`/`host.importFromFile` each resolve only once their
 * whole step completes, so the live byte counter comes from a separate
 * subscription (`host.onTransferProgress`) filtered to this hook's tabId --
 * `runTransfer` itself only reports which step is running and how it ended.
 *
 * Retry always restarts from `exporting`: `importFromFile` deletes its local
 * temp file in a `finally` regardless of outcome (see
 * `main/connections/transfer.ts`), so there is no partially-completed local
 * artifact a later step could resume from.
 */
import { useCallback, useRef, useState } from 'react'
import type { ExportFileOptions, TransferLanding, TransferProgress } from '@ion/shared/types-transfer'
import { runWorktreeMove, runLocalMove, type WorktreeMoveResult, type TransferRefusal, type TransferStep } from './transfer-flow'
import { host, action } from '../../host/host-instance'
import { rError } from '../../rendererLogger'

export type TransferStatus = 'idle' | 'exporting' | 'importing' | 'removing' | 'moving' | 'succeeded' | 'failed'

export interface TransferState {
  status: TransferStatus
  /** Byte progress for the current export/import step; null while removing the original, or idle. */
  progress: TransferProgress | null
  /** Set only when `status === 'failed'`. `tabId` names which conversation of a worktree move failed. */
  failure: { step: TransferStep; refusal: TransferRefusal; tabId?: string } | null
  /** Set only when `status === 'succeeded'`. */
  targetEnvironmentId: string | null
  targetTabId: string | null
  /** Conversations already across / in this move, so a worktree move can show "2 of 3". */
  movedCount: number
  totalCount: number
  /** Where the conversation lives now, after a move within one machine. */
  workingDirectory: string | null
}

const IDLE_STATE: TransferState = { status: 'idle', progress: null, failure: null, targetEnvironmentId: null, targetTabId: null, movedCount: 0, totalCount: 0, workingDirectory: null }

export interface UseTransferResult extends TransferState {
  /**
   * Starts a fresh transfer. Safe to call again after `failed`/`succeeded`
   * -- it replaces whatever ran before. `siblingTabIds` are the other
   * conversations in the same worktree, moved after `tabId`.
   */
  start(sourceEnvironmentId: string, tabId: string, targetEnvironmentId: string, exportOptions?: ExportFileOptions, siblingTabIds?: readonly string[], landing?: TransferLanding | null): void
  /** Moves the conversation to another checkout or worktree on the machine it already lives on (`runLocalMove`). */
  moveHere(environmentId: string, tabId: string, landing: TransferLanding): void
  /** Re-runs the whole flow with the last-started args. No-op if nothing has been started yet. */
  retry(): void
  /** Returns to `idle` (dismissing a finished/failed card). */
  reset(): void
  /**
   * Abandons the step in flight. The host stops the stream, the flow reports
   * a `cancelled` refusal, and the card lands in `failed` with Retry offered
   * — cancelling is a decision to stop now, not a decision never to try
   * again. No-op when nothing is running.
   */
  cancel(): void
}

/** React hook: drives one transfer at a time and exposes its live state. */
export function useTransfer(): UseTransferResult {
  const [state, setState] = useState<TransferState>(IDLE_STATE)
  const lastArgsRef = useRef<
    | { kind: 'transfer'; sourceEnvironmentId: string; tabId: string; targetEnvironmentId: string; exportOptions: ExportFileOptions; siblingTabIds: readonly string[]; landing: TransferLanding | null }
    | { kind: 'move-here'; environmentId: string; tabId: string; landing: TransferLanding }
    | null
  >(null)
  const runIdRef = useRef(0)

  const run = useCallback((sourceEnvironmentId: string, tabId: string, targetEnvironmentId: string, exportOptions: ExportFileOptions = {}, siblingTabIds: readonly string[] = [], landing: TransferLanding | null = null) => {
    lastArgsRef.current = { kind: 'transfer', sourceEnvironmentId, tabId, targetEnvironmentId, exportOptions, siblingTabIds, landing }
    const runId = ++runIdRef.current
    const tabIds = [tabId, ...siblingTabIds]
    const tabSet = new Set(tabIds)
    setState({ ...IDLE_STATE, status: 'exporting', totalCount: tabIds.length })

    const offProgress = host.onTransferProgress((progress) => {
      if (runId !== runIdRef.current || !tabSet.has(progress.tabId)) return
      setState((prev) => ({
        ...prev,
        status: progress.direction === 'export' ? 'exporting' : 'importing',
        progress,
      }))
    })

    runWorktreeMove(sourceEnvironmentId, tabIds, targetEnvironmentId, {
      exportToFile: (env, tab, target, options) => {
        if (runId === runIdRef.current) setState((prev) => ({ ...prev, status: 'exporting', movedCount: tabIds.indexOf(tab) }))
        return host.exportToFile(env, tab, target, options)
      },
      importFromFile: (env, tab, filePath, landing) => {
        if (runId === runIdRef.current) setState((prev) => ({ ...prev, status: 'importing' }))
        return host.importFromFile(env, tab, filePath, landing)
      },
      action: (env, name, args) => {
        if (runId === runIdRef.current) setState((prev) => ({ ...prev, status: 'removing', progress: null }))
        return action(env, name, args)
      },
    }, exportOptions, landing)
      .then((result: WorktreeMoveResult) => {
        if (runId !== runIdRef.current) return
        if (result.ok) {
          setState({
            status: 'succeeded',
            progress: null,
            failure: null,
            targetEnvironmentId: result.targetEnvironmentId,
            targetTabId: result.targetTabId ?? null,
            movedCount: result.moved.length,
            totalCount: tabIds.length,
            workingDirectory: null,
          })
        } else {
          const failed = result.failed!
          setState({ ...IDLE_STATE, status: 'failed', failure: { step: failed.step, refusal: failed.refusal, tabId: failed.tabId }, movedCount: result.moved.length, totalCount: tabIds.length })
        }
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return
        rError('transfer', 'transfer flow threw unexpectedly', { error: err instanceof Error ? err.message : String(err) })
        setState({
          ...IDLE_STATE,
          status: 'failed',
          failure: { step: 'exporting', refusal: { code: 'failed', message: err instanceof Error ? err.message : String(err) } },
          totalCount: tabIds.length,
        })
      })
      .finally(() => offProgress())
  }, [])

  const moveHere = useCallback((environmentId: string, tabId: string, landing: TransferLanding) => {
    lastArgsRef.current = { kind: 'move-here', environmentId, tabId, landing }
    const runId = ++runIdRef.current
    setState({ ...IDLE_STATE, status: 'moving', totalCount: 1 })
    runLocalMove(environmentId, tabId, landing, { action })
      .then((result) => {
        if (runId !== runIdRef.current) return
        setState(result.ok
          ? { ...IDLE_STATE, status: 'succeeded', targetEnvironmentId: environmentId, targetTabId: tabId, movedCount: 1, totalCount: 1, workingDirectory: result.workingDirectory ?? null }
          : { ...IDLE_STATE, status: 'failed', failure: { step: result.step, refusal: result.refusal }, totalCount: 1 })
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return
        rError('transfer', 'local move threw unexpectedly', { error: err instanceof Error ? err.message : String(err) })
        setState({ ...IDLE_STATE, status: 'failed', failure: { step: 'moving', refusal: { code: 'failed', message: err instanceof Error ? err.message : String(err) } }, totalCount: 1 })
      })
  }, [])

  const retry = useCallback(() => {
    const last = lastArgsRef.current
    if (!last) return
    if (last.kind === 'move-here') { moveHere(last.environmentId, last.tabId, last.landing); return }
    run(last.sourceEnvironmentId, last.tabId, last.targetEnvironmentId, last.exportOptions, last.siblingTabIds, last.landing)
  }, [run, moveHere])

  const cancel = useCallback(() => {
    const last = lastArgsRef.current
    // A move within one machine streams nothing, so there is nothing to cancel.
    if (!last || last.kind !== 'transfer') return
    // Every conversation of a worktree move shares one dialog, so cancel the
    // whole family: whichever tab's stream is actually open is the one the
    // host finds.
    for (const tabId of [last.tabId, ...last.siblingTabIds]) {
      host.cancelTransfer(tabId).catch((err: unknown) => rError('transfer', 'cancel request failed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [])

  const reset = useCallback(() => {
    runIdRef.current += 1
    setState(IDLE_STATE)
  }, [])

  return { ...state, start: run, moveHere, retry, reset, cancel }
}
