import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsClockwise, ChatCircle, MagnifyingGlass, Terminal, Trash, Warning } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { rError } from '../../rendererLogger'
import { ConfirmDialog } from '../../components/git/ConfirmDialog'
import { ConflictsDialog } from '../../components/git/ConflictsDialog'
import type { IntegrationWorkspace } from '../../../shared/types'

export function InboxBenchMenu({ repoPath, workspace, anchor, onClose }: { repoPath: string; workspace: IntegrationWorkspace; anchor: { x: number; y: number }; onClose(): void }): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const [recordingCount, setRecordingCount] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [recoverConflict, setRecoverConflict] = useState(false)
  const [conflictDirectory, setConflictDirectory] = useState<string | null>(null)
  const dismiss = useCallback(() => {
    if (confirmClear || recoverConflict) return
    onClose()
  }, [confirmClear, onClose, recoverConflict])
  useOutsideDismiss([menuRef], dismiss)
  const pos = useAnchoredPopover(anchor, { deps: [recordingCount, confirmClear, recoverConflict] })
  useEffect(() => { void useSessionStore.getState().benchRerereCount(workspace.benchPath).then(setRecordingCount).catch((error) => rError('inbox.bench-menu', 'recording count failed', { error: String(error) })) }, [workspace.benchPath])
  const run = (label: string, operation: () => Promise<unknown> | void): void => { void Promise.resolve(operation()).catch((error) => rError('inbox.bench-menu', 'bench action failed', { action: label, error: String(error) })); onClose() }
  const clear = (): void => { setConfirmClear(false); run('clear replay cache', async () => { await useSessionStore.getState().benchRerereDiscardAll(workspace.benchPath); await useSessionStore.getState().refreshWorkspaceViews(repoPath) }) }
  const recover = (): void => {
    setRecoverConflict(false)
    void useSessionStore.getState().benchResolveConflict(repoPath, workspace.sourceBranch)
      .then((benchPath) => {
        if (benchPath) setConflictDirectory(benchPath)
        else onClose()
      })
      .catch((error) => rError('inbox.bench-menu', 'recover conflict failed', {
        bench_path: workspace.benchPath,
        error: String(error),
      }))
  }
  const menu = <div ref={(node) => {
    ;(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    pos.ref(node)
  }} data-testid="inbox-bench-menu" data-ion-ui style={{ position: 'fixed', left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden', zIndex: 1000, pointerEvents: 'auto', width: 230, padding: 4, border: `1px solid ${colors.popoverBorder}`, borderRadius: 6, background: colors.popoverBg, boxShadow: colors.popoverShadow }}>
    {!confirmClear && !recoverConflict && <>
      <MenuItem icon={<ChatCircle size={14} />} label="Open Bench Conversation" onClick={() => run('open bench conversation', () => useSessionStore.getState().openBenchConversation(repoPath, workspace.sourceBranch))} />
      <MenuItem icon={<Terminal size={14} />} label="Open Bench Terminal" onClick={() => run('open bench terminal', () => useSessionStore.getState().openBenchTerminal(repoPath, workspace.sourceBranch))} />
      <MenuItem icon={<ArrowsClockwise size={14} />} label="Sync worktree pipeline" onClick={() => run('start worktree pipeline', () => useSessionStore.getState().startWorktreePipeline(repoPath, workspace.sourceBranch))} />
      <MenuItem icon={<ArrowsClockwise size={14} />} label="Assemble / Update Bench" onClick={() => run('assemble bench', () => useSessionStore.getState().benchUpdateAll(repoPath, workspace.sourceBranch))} />
      <MenuItem icon={<Warning size={14} />} label="Recover conflict" onClick={() => setRecoverConflict(true)} />
      <MenuItem icon={<MagnifyingGlass size={14} />} label="Verification analysis" onClick={() => run('open verification analysis', () => useSessionStore.getState().openBenchVerificationAnalysis(repoPath, workspace.sourceBranch))} />
      <MenuItem icon={<Trash size={14} />} label={`Clear replay cache${recordingCount == null ? '' : ` (${recordingCount})`}`} disabled={recordingCount === 0} danger onClick={() => setConfirmClear(true)} />
    </>}
    {confirmClear && <ConfirmDialog title="Clear replay cache?" message={`This removes ${recordingCount ?? 0} recorded conflict resolution${recordingCount === 1 ? '' : 's'} for this bench.`} confirmLabel="Clear cache" danger onConfirm={clear} onCancel={() => setConfirmClear(false)} />}
    {recoverConflict && <ConfirmDialog title="Recover bench conflict?" message="Ion will recreate the failed bench merge so you can resolve it." confirmLabel="Recover conflict" onConfirm={recover} onCancel={() => setRecoverConflict(false)} />}
    {conflictDirectory && <ConflictsDialog directory={conflictDirectory} onClose={() => { setConflictDirectory(null); onClose() }} />}
  </div>
  return layer ? createPortal(menu, layer) : menu
}

function MenuItem({ icon, label, onClick, disabled = false, danger = false }: { icon: React.ReactNode; label: string; onClick(): void; disabled?: boolean; danger?: boolean }): React.JSX.Element {
  const colors = useColors()
  return <button disabled={disabled} onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '6px 7px', border: 'none', borderRadius: 4, background: 'transparent', color: danger ? colors.dangerFg : colors.textPrimary, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer', fontSize: 11, textAlign: 'left' }}>{icon}{label}</button>
}
