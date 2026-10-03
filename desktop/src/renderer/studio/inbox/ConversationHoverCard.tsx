import { useEnvironmentDeveloperSurfaces } from '../connection/developer-surfaces'
import { tabEnvironmentId } from '../connection/tab-environment'
import { useEnvironmentInfo } from '../transfer/environment-label-cache'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import React, { type RefObject } from 'react'
import { Broadcast } from '@phosphor-icons/react'
import { HoverCard } from '../../components/git/HoverCard'
import { latestConversationActivityAt } from '@ion/shared/inbox-classify'
import type { TabState } from '@ion/shared/types'
import { inboxProjectFor, inboxWorktreeFor } from './inbox-grouping'
import type { IntegrationWorkspace, WorktreeInventoryEntry } from '@ion/shared/types'

function stamp(value: number | null | undefined): string {
  return value == null ? 'Unknown' : new Date(value).toLocaleString()
}

/** Shared non-interactive detail reveal for every Inbox conversation row. */
export function ConversationHoverCard({
  tab,
  benches,
  inventory,
  rightBoundaryRef,
  children,
}: {
  tab: TabState
  benches: ReadonlyMap<string, readonly IntegrationWorkspace[]>
  inventory: ReadonlyMap<string, readonly WorktreeInventoryEntry[]>
  rightBoundaryRef?: RefObject<HTMLElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const project = inboxProjectFor(tab, benches)
  const location = inboxWorktreeFor(tab, benches, inventory)
  const result = tab.lastResult
  const rowEnvironmentId = tabEnvironmentId(tab)
  const developerSurfaces = useEnvironmentDeveloperSurfaces(rowEnvironmentId)
  const environmentInfo = useEnvironmentInfo(rowEnvironmentId === LOCAL_ENVIRONMENT_ID ? null : rowEnvironmentId)
  // Host is where the conversation runs. A conversation on another
  // environment names that environment, with the same remote mark the row's
  // badge carries and its address on hover; a local one names the execution
  // host the engine reported, else this desktop.
  const host: React.ReactNode = environmentInfo
    ? <span data-testid="hover-card-remote-host" title={environmentInfo.url ?? undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Broadcast size={11} weight="bold" aria-label="Remote environment" />{environmentInfo.label}</span>
    : tab.executionHost || 'Local desktop'
  const rows: Array<[string, React.ReactNode]> = [
    ['Project', project.name],
    ...(developerSurfaces.worktrees ? [['Location', location.label] as [string, React.ReactNode]] : []),
    ...(developerSurfaces.repositoryStatus && tab.worktree?.branchName ? [['Branch', tab.worktree.branchName] as [string, React.ReactNode]] : []),
    ...(tab.settledOverride === 'auto' ? [['Settlement', 'Auto'] as [string, React.ReactNode]] : []),
    ['Host', host],
    ...(tab.executionMachineId ? [['Machine', tab.executionMachineId] as [string, React.ReactNode]] : []),
    ['Last activity', stamp(latestConversationActivityAt(tab))],
    ...(tab.lastCompletionAt ? [['Completed', stamp(tab.lastCompletionAt)] as [string, React.ReactNode]] : []),
    ...(tab.settledAt ? [['Settled', stamp(tab.settledAt)] as [string, React.ReactNode]] : []),
    ...(result ? [['Prompts', String(result.conversationTurns ?? result.numTurns)], ['Duration', `${Math.round(result.durationMs / 1_000)}s`], ['Cost', `$${result.totalCostUsd.toFixed(4)}`]] as Array<[string, React.ReactNode]> : []),
  ]
  return (
    <HoverCard
      position="right"
      rightBoundaryRef={rightBoundaryRef}
      delayMs={0}
      maxWidth={320}
      fallbackTitle={`${project.name} · ${location.label}`}
      content={<div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '3px 8px' }}>
        {rows.map(([label, value]) => <React.Fragment key={label}><span style={{ opacity: 0.65 }}>{label}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span></React.Fragment>)}
      </div>}
      style={{ display: 'flex', minWidth: 0, width: '100%' }}
    >
      {children}
    </HoverCard>
  )
}
