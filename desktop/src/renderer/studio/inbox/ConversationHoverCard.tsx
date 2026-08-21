import React from 'react'
import { HoverCard } from '../../components/git/HoverCard'
import type { TabState } from '../../../shared/types'
import { inboxProjectFor, inboxWorktreeFor } from './inbox-grouping'
import type { IntegrationWorkspace, WorktreeInventoryEntry } from '../../../shared/types'

function stamp(value: number | null | undefined): string {
  return value == null ? 'Unknown' : new Date(value).toLocaleString()
}

/** Shared non-interactive detail reveal for every Inbox conversation row. */
export function ConversationHoverCard({
  tab,
  benches,
  inventory,
  children,
}: {
  tab: TabState
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]>
  children: React.ReactNode
}): React.JSX.Element {
  const project = inboxProjectFor(tab, benches)
  const location = inboxWorktreeFor(tab, benches, inventory)
  const result = tab.lastResult
  const rows = [
    ['Project', project.name],
    ['Location', location.label],
    ...(tab.worktree?.branchName ? [['Branch', tab.worktree.branchName]] : []),
    ...(tab.settledOverride === 'auto' ? [['Settlement', 'Auto']] : []),
    ['Host', tab.executionHost || 'Local desktop'],
    ...(tab.executionMachineId ? [['Machine', tab.executionMachineId]] : []),
    ['Last activity', stamp(tab.lastMessageAt ?? tab.lastActivityAt)],
    ...(tab.settledAt ? [['Settled', stamp(tab.settledAt)]] : []),
    ...(result ? [['Prompts', String(result.conversationTurns ?? result.numTurns)], ['Duration', `${Math.round(result.durationMs / 1_000)}s`], ['Cost', `$${result.totalCostUsd.toFixed(4)}`]] : []),
  ]
  return (
    <HoverCard
      position="right"
      delayMs={0}
      maxWidth={320}
      fallbackTitle={`${project.name} · ${location.label}`}
      content={<div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '3px 8px' }}>
        {rows.map(([label, value]) => <React.Fragment key={label}><span style={{ opacity: 0.65 }}>{label}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span></React.Fragment>)}
      </div>}
      style={{ display: 'flex', minWidth: 0, flex: 1 }}
    >
      {children}
    </HoverCard>
  )
}
