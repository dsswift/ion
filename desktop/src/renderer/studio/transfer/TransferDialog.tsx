/**
 * TransferDialog — the Transfer verb's modal: choose what moves (for a
 * worktree conversation: just it, or the whole worktree), where to, and
 * where it lands there — a project's checkout, one of its worktrees, or a
 * new one; run the move via `useTransfer`; render its progress, refusal,
 * and success states.
 *
 * The machine the conversation is already on is a target too. That is a
 * move within one machine: nothing is exported, the conversation is
 * repointed at its new checkout or worktree (`transfer.relocate`).
 *
 * On success, the destination lives in a DIFFERENT environment's tab list.
 * The union store already merges every connected environment's tabs, so
 * widening the view filter is what makes the new tab visible — there is no
 * cross-environment "open and focus a remote conversation" surface yet
 * (only the local session store's `selectTab` can make a tab the active
 * one), so that is the honest scope of "select the new tab" here: bring the
 * target environment into view, not focus the specific conversation inside
 * it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useProjectsByEnvironment } from '../connection/environment-projects'
import { sourceProjectFor } from './plain-destination'
import { TransferDestinationFields } from './TransferDestinationFields'
import { useTransferLanding } from './useTransferLanding'
import { landsWhereItIs } from './landing-choice'
import { useColors } from '../../theme'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import { useTabEnvironmentId } from '../connection/tab-environment'
import { readCatalog } from '../connection/catalog'
import { useEnvironmentViewFilter } from '../connection/view-filter'
import { host } from '../../host/host-instance'
import { useTransfer } from './useTransfer'
import { useTransferPreflight, type TransferMode } from './useTransferPreflight'
import { TransferPreflightPanel } from './TransferPreflightPanel'
import { STEP_LABEL } from './transfer-labels'
import { rInfo, rWarn } from '../../rendererLogger'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

export interface TransferDialogProps {
  tabId: string
  /** What moves when the dialog opens. A worktree's own Transfer opens on `worktree`; a conversation's on `conversation`. */
  initialMode?: TransferMode
  onClose(): void
}

const NO_PROJECTS: readonly EnvironmentProject[] = []

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The whole catalog (for the project lists this dialog resolves names and
 * repositories from), and every connected environment, the conversation's
 * own included: a conversation can move within the machine it is on.
 */
async function loadCatalogAndTargets(): Promise<{ catalog: EnvironmentCatalogEntry[]; targets: EnvironmentCatalogEntry[] }> {
  const [catalog, connections] = await Promise.all([readCatalog(), host.connections()])
  const connectedIds = new Set(connections.filter((c) => c.phase.phase === 'connected').map((c) => c.environmentId))
  return { catalog, targets: catalog.filter((entry) => connectedIds.has(entry.id)) }
}

export function TransferDialog({ tabId, initialMode = 'conversation', onClose }: TransferDialogProps): React.JSX.Element {
  const colors = useColors()
  const [candidates, setCandidates] = useState<EnvironmentCatalogEntry[] | null>(null)
  const [catalog, setCatalog] = useState<EnvironmentCatalogEntry[]>([])
  const [targetEnvironmentId, setTargetEnvironmentId] = useState('')
  const [mode, setMode] = useState<TransferMode>(initialMode)
  const [viewFilter, setViewFilter] = useEnvironmentViewFilter()
  const transfer = useTransfer()
  const sourceEnvironmentId = useTabEnvironmentId(tabId)
  const targetLabel = candidates?.find((c) => c.id === targetEnvironmentId)?.label ?? targetEnvironmentId
  // A menu open inside the dialog owns Escape: it closes the menu, not the dialog.
  const [menuOpen, setMenuOpen] = useState(false)

  // Every environment's project list: the source's to resolve which
  // repository the conversation is in, the destination's to name each
  // directory it could land in.
  const projectsByEnvironment = useProjectsByEnvironment(catalog)
  const sourceWorkingDirectory = useSessionStore((s) => s.tabs.find((t) => t.id === tabId)?.workingDirectory ?? '')
  const resolvedHere = useMemo(
    () => sourceProjectFor(sourceWorkingDirectory, projectsByEnvironment[sourceEnvironmentId] ?? []),
    [sourceWorkingDirectory, projectsByEnvironment, sourceEnvironmentId],
  )
  const targetProjects = projectsByEnvironment[targetEnvironmentId] ?? NO_PROJECTS
  const preflight = useTransferPreflight(sourceEnvironmentId, tabId, targetEnvironmentId, targetLabel || 'the destination', resolvedHere, mode, targetProjects)
  const worktree = preflight.description?.worktree ?? null
  const landing = useTransferLanding(targetEnvironmentId, mode === 'conversation' ? preflight.destinationDirectory : '', worktree?.sourceBranch ?? null)
  // A whole worktree only ever leaves its machine; a conversation on its own
  // can also move within it.
  const targets = useMemo(
    () => (candidates ?? []).filter((entry) => mode === 'conversation' || entry.id !== sourceEnvironmentId),
    [candidates, mode, sourceEnvironmentId],
  )
  const movesWithinMachine = mode === 'conversation' && targetEnvironmentId === sourceEnvironmentId
  const samePlace = movesWithinMachine && landsWhereItIs(landing.landing, sourceWorkingDirectory)
  const canStart = preflight.ready && (mode === 'worktree' || (!!landing.landing && !samePlace))

  // Switching to a whole-worktree move takes this machine off the list; the
  // target moves to the first other one rather than silently staying on a
  // choice that is no longer offered.
  useEffect(() => {
    if (!candidates || targets.some((t) => t.id === targetEnvironmentId)) return
    setTargetEnvironmentId(targets[0]?.id ?? '')
  }, [candidates, targets, targetEnvironmentId])

  useEffect(() => {
    let cancelled = false
    loadCatalogAndTargets()
      .then(({ catalog: all, targets: connected }) => {
        if (cancelled) return
        setCatalog(all)
        setCandidates(connected)
        // Another machine first when there is one: that is what Transfer
        // usually means. This machine stays in the list for a move within it.
        const first = connected.find((entry) => entry.id !== sourceEnvironmentId) ?? connected[0]
        if (first) setTargetEnvironmentId(first.id)
      })
      .catch((err) => {
        rWarn('transfer.dialog', 'connected-target load failed', { error: String(err) })
        if (!cancelled) setCandidates([])
      })
    return () => {
      cancelled = true
    }
  }, [sourceEnvironmentId])

  /**
   * A finished transfer must not leave the conversation it just moved
   * invisible -- but it may only WIDEN the Inbox to achieve that, never
   * narrow it.
   *
   * This used to pin the filter to the transfer's target, which is how a
   * single transfer to this Mac silently hid every other host's
   * conversations. The filter is a persisted device setting, so it stayed
   * that way across restarts, and at the time nothing in the UI could set
   * it back.
   */
  useEffect(() => {
    if (transfer.status !== 'succeeded' || !transfer.targetEnvironmentId) return
    const targetFilter = transfer.targetEnvironmentId === LOCAL_ENVIRONMENT_ID ? 'local' : transfer.targetEnvironmentId
    if (viewFilter === 'all' || viewFilter === targetFilter) return
    rInfo('transfer.dialog', 'widening the inbox environment filter so the transferred conversation is visible', {
      was: viewFilter, target_environment_id: transfer.targetEnvironmentId,
    })
    setViewFilter('all')
  }, [transfer.status, transfer.targetEnvironmentId, viewFilter, setViewFilter])

  // Escape always dismisses, and while a step is running it cancels on the
  // way out. The dialog is the only thing watching a transfer, so closing it
  // over a live stream would leave one running with nothing to report to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menuOpenRef.current) return
      e.stopPropagation()
      if (busyRef.current) transferRef.current.cancel()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const busy = transfer.status === 'exporting' || transfer.status === 'importing' || transfer.status === 'removing' || transfer.status === 'moving'
  // Read by the Escape handler, which is bound once so a keypress can never
  // race a re-render into a stale closure.
  const busyRef = useRef(busy)
  const menuOpenRef = useRef(menuOpen)
  menuOpenRef.current = menuOpen
  const transferRef = useRef(transfer)
  const onCloseRef = useRef(onClose)
  busyRef.current = busy
  transferRef.current = transfer
  onCloseRef.current = onClose
  const buttonStyle: React.CSSProperties = {
    fontSize: 12,
    color: colors.textPrimary,
    background: 'transparent',
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
  }

  return (
    <div
      // Same marker ConfirmDialog uses: a mousedown inside this backdrop must
      // not read as "outside" to any menu's useOutsideDismiss.
      data-ion-confirm
      style={{
        // TransferDialogHost renders this dialog into PopoverLayer, and that
        // layer is `pointerEvents: 'none'` so it never swallows clicks
        // meant for the app beneath it. A child opts back in or every control
        // inside it is inert — the dialog paints, and the buttons read as
        // text. ConfirmDialog does the same.
        pointerEvents: 'auto',
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.scrim,
        zIndex: 10000,
        padding: 16,
        boxSizing: 'border-box',
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        data-ion-ui
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360,
          maxWidth: '100%',
          background: colors.popoverBg,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: `1px solid ${colors.popoverBorder}`,
          boxShadow: colors.popoverShadow,
          borderRadius: 12,
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, color: colors.textPrimary, marginBottom: 12 }}>Transfer conversation</div>

        {candidates === null && <div style={{ fontSize: 12, color: colors.textTertiary }}>Loading environments…</div>}
        {candidates !== null && targets.length === 0 && (
          <div style={{ fontSize: 12, color: colors.textTertiary, marginBottom: 12 }}>No other connected environments are available.</div>
        )}

        {targets.length > 0 && transfer.status === 'idle' && (
          <>
            <TransferDestinationFields
              mode={mode}
              onModeChange={setMode}
              worktreeSiblingCount={worktree ? worktree.siblings.length : null}
              targets={targets}
              sourceEnvironmentId={sourceEnvironmentId}
              targetEnvironmentId={targetEnvironmentId}
              onTargetChange={setTargetEnvironmentId}
              targetLabel={targetLabel}
              targetProjects={targetProjects}
              preflight={preflight}
              landing={landing}
              landsWhereItIs={samePlace}
              onOpenChange={setMenuOpen}
            />
            <TransferPreflightPanel state={preflight} targetLabel={targetLabel} />
          </>
        )}

        {busy && (
          <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 12 }}>
            {STEP_LABEL[transfer.status as 'exporting' | 'importing' | 'removing' | 'moving']}{transfer.totalCount > 1 ? ` (${Math.min(transfer.movedCount + 1, transfer.totalCount)} of ${transfer.totalCount})` : ''}
            {transfer.progress ? ` — ${formatBytes(transfer.progress.bytesTransferred)} / ${formatBytes(transfer.progress.totalBytes)}` : '…'}
          </div>
        )}

        {transfer.status === 'failed' && transfer.failure && (
          <div style={{ fontSize: 12, color: colors.dangerFg, marginBottom: 12 }}>
            {STEP_LABEL[transfer.failure.step]} failed ({transfer.failure.refusal.code}): {transfer.failure.refusal.message}{transfer.totalCount > 1 ? ` — ${transfer.movedCount} of ${transfer.totalCount} conversations are across; Retry resumes.` : ''}
          </div>
        )}

        {transfer.status === 'succeeded' && (
          <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 12 }}>
            {transfer.workingDirectory
              ? `Moved. It now lives in ${transfer.workingDirectory}.`
              : transfer.totalCount > 1 ? `Moved ${transfer.movedCount} conversations with the worktree. The originals are gone from the source.` : 'Moved. The original is gone from the source.'}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {transfer.status === 'failed' && (
            <button style={buttonStyle} onClick={() => transfer.retry()}>Retry</button>
          )}
          {transfer.status === 'idle' && targets.length > 0 && (
            <button
              style={{ ...buttonStyle, opacity: canStart ? 1 : 0.5, cursor: canStart ? 'pointer' : 'default' }}
              disabled={!canStart}
              title={canStart ? undefined : 'Resolve the items above first'}
              onClick={() => {
                if (mode === 'worktree') {
                  transfer.start(sourceEnvironmentId, tabId, targetEnvironmentId, preflight.exportOptions, preflight.siblingTabIds, null)
                } else if (landing.landing && movesWithinMachine) {
                  transfer.moveHere(sourceEnvironmentId, tabId, landing.landing)
                } else if (landing.landing) {
                  transfer.start(sourceEnvironmentId, tabId, targetEnvironmentId, preflight.exportOptions, [], landing.landing)
                }
              }}
            >
              {mode === 'worktree' ? `Move worktree${preflight.siblingTabIds.length > 0 ? ` (${preflight.siblingTabIds.length + 1} conversations)` : ''}` : movesWithinMachine ? 'Move' : 'Transfer'}
            </button>
          )}
          {busy && (
            <button style={buttonStyle} onClick={() => transfer.cancel()}>Cancel</button>
          )}
          <button
            style={buttonStyle}
            onClick={() => {
              // Closing over a live stream cancels it: nothing else is
              // watching, and a transfer whose progress no one can see is the
              // state this dialog exists to prevent.
              if (busy) transfer.cancel()
              onClose()
            }}
          >
            {transfer.status === 'succeeded' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
