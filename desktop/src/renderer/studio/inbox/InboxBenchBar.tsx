import React from 'react'
import { ArrowsClockwise, CaretDown, CaretRight, CircleNotch, DotsThree, Terminal } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { Tooltip } from '../../components/git/Tooltip'
import type { DirConversation } from '../../../shared/worktree-conversations'
import type { IntegrationWorkspace } from '../../../shared/types'

/** The compact Inbox header for one integration bench. */
export function InboxBenchBar({
  workspace,
  conversations,
  terminalTabId,
  expanded,
  onToggle,
  onCycle,
  onOpenTerminal,
  onMenu,
  statusRow,
  onSyncAll,
  statusText,
  onAssemble,
  assembling,
}: {
  workspace: IntegrationWorkspace
  conversations: readonly DirConversation[]
  terminalTabId?: string
  expanded: boolean
  onToggle(): void
  onCycle(): void
  onOpenTerminal(): void
  onMenu(anchor: { x: number; y: number }): void
  /** The workspace-wide sync/pipeline state, rendered in header row two. */
  statusRow?: React.ReactNode
  onSyncAll(): void
  /** Stable bench state when no pipeline banner is active. */
  statusText: string
  /** Assemble from the current pins. Same verb as the "..." menu's "Assemble / Update Bench". */
  onAssemble(): void
  /** True while an assembly for this bench is in flight — spins the icon and blocks re-entry. */
  assembling: boolean
}): React.JSX.Element {
  const colors = useColors()
  return <div
    data-testid={`inbox-bench-bar-${workspace.sourceBranch}`}
    onContextMenu={(event) => {
      event.preventDefault()
      event.stopPropagation()
      onMenu({ x: event.clientX, y: event.clientY })
    }}
    style={{ display: 'flex', flexDirection: 'column', gap: 3, width: 'calc(100% - 20px)', margin: '5px 10px 2px', padding: '5px 8px', border: `1px solid ${colors.containerBorder}`, borderRadius: 5, background: colors.surfacePrimary, color: colors.textSecondary, fontSize: 11, fontWeight: 600 }}
  >
    <div onClick={onCycle} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: conversations.length > 0 ? 'pointer' : 'default' }}>
      <button aria-label="Toggle bench" onClick={(event) => { event.stopPropagation(); onToggle() }} style={buttonStyle(colors)}>{expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}</button>
      <Tooltip text={assembling ? 'Assembling the bench from its pins…' : 'Assemble the bench from the current pins'}>
        <button
          aria-label="Assemble bench"
          data-testid={`inbox-bench-assemble-${workspace.sourceBranch}`}
          onClick={(event) => { event.stopPropagation(); onAssemble() }}
          disabled={assembling}
          style={{ ...buttonStyle(colors), color: colors.warningFg, cursor: assembling ? 'default' : 'pointer' }}
        >
          {assembling ? <CircleNotch size={13} className="animate-spin" /> : <ArrowsClockwise size={13} />}
        </button>
      </Tooltip>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Bench · {workspace.sourceBranch}</span>
      <span style={{ color: colors.textTertiary, fontSize: 10 }}>{conversations.length}</span>
      <button
        aria-label={terminalTabId ? 'Go to bench terminal' : 'Open bench terminal'}
        onClick={(event) => { event.stopPropagation(); onOpenTerminal() }}
        style={buttonStyle(colors)}
      ><Terminal size={13} /></button>
      <button
        aria-label="Bench actions"
        onClick={(event) => { event.stopPropagation(); onMenu({ x: event.clientX, y: event.clientY }) }}
        style={buttonStyle(colors)}
      ><DotsThree size={14} weight="bold" /></button>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} onClick={(event) => event.stopPropagation()}>
      <button aria-label="Sync all worktrees" onClick={onSyncAll} style={{ ...buttonStyle(colors), border: `1px solid ${colors.accent}`, borderRadius: 3, padding: '2px 7px', color: colors.accent, fontSize: 10 }}>Sync All</button>
      <span data-testid={`inbox-bench-status-${workspace.sourceBranch}`} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: colors.textTertiary, fontSize: 10 }}>{statusText}</span>
      {statusRow}
    </div>
  </div>
}

function buttonStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return { display: 'inline-flex', border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', padding: 0 }
}
