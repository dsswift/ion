import React, { useEffect, useRef, useState } from 'react'
import { Check, ClockCounterClockwise, PushPin, PushPinSlash, WarningCircle } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useQuestionsStore } from '../../stores/questions-store'
import { activeInstance } from '../../stores/conversation-instance'
import { getWaitingState, formatRelativeShort } from '../../components/TabStripShared'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { InboxRowMenu } from './InboxRowMenu'
import { availableSnoozePresets } from './inbox-snooze-presets'
import { ConversationHoverCard } from './ConversationHoverCard'
import { inboxWorktreeFor } from './inbox-grouping'
import { latestConversationActivityAt } from '../../../shared/inbox-classify'
import type { IntegrationWorkspace, TabState, WorktreeInventoryEntry } from '../../../shared/types'

export type InboxRowVariant = 'card' | 'slim'

export function InboxRow({
  tab, unread, woke, projectName, variant, backgroundLiveness, selected, onToggleSelected, onOpen, canRestore = true, benches = new Map(), inventory = new Map(), rightBoundaryRef,
}: {
  tab: TabState
  unread: boolean
  woke: boolean
  projectName: string | null
  variant: InboxRowVariant
  backgroundLiveness: 'working' | 'monitoring' | null
  selected?: boolean
  onToggleSelected?: (shift: boolean) => void
  /** Opens a cold settled record before selecting it. Defaults to normal tab selection. */
  onOpen?: (tab: TabState) => void
  /** False when a settled record's worktree was retired and cannot resume. */
  canRestore?: boolean
  benches?: ReadonlyMap<string, readonly IntegrationWorkspace[]>
  inventory?: ReadonlyMap<string, readonly WorktreeInventoryEntry[]>
  /** Right edge of the Inbox panel; hover details open beyond it. */
  rightBoundaryRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const isActive = useSessionStore((state) => state.activeTabId === tab.id)
  const pendingAsk = useSessionStore((state) => {
    const instance = activeInstance(state.conversationPanes, tab.id)
    return (instance?.permissionQueue.length ?? 0) + (instance?.elicitationQueue.length ?? 0) > 0
  })
  // A Guided Questions round is a waiting state that lives outside
  // permissionDenied, so subscribe to the questions store too or the row
  // renders idle while the operator owes an answer.
  useQuestionsStore((s) => s.workflows)
  const waiting = useSessionStore((state) => getWaitingState(tab, state.conversationPanes))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(tab.customTitle ?? tab.title)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (renaming) inputRef.current?.focus() }, [renaming])

  const status = pendingAsk ? 'Approval'
    : waiting === 'plan-ready' ? 'Plan Ready'
    : waiting ? 'Input'
    : tab.status === 'failed' ? 'Failed'
    : tab.status === 'starting' ? 'Connecting'
    : backgroundLiveness === 'monitoring' ? 'Monitoring'
    : tab.status === 'running' || tab.status === 'connecting' || backgroundLiveness === 'working' ? 'Working'
    : unread ? 'Done'
    : null
  const statusColor = status === 'Failed' ? colors.dangerFg
    : status === 'Approval' ? colors.statusPermission
    : status === 'Input' || status === 'Plan Ready' ? colors.accent
    : status === 'Working' || status === 'Monitoring' ? colors.statusRunning
    : status === 'Connecting' ? colors.textTertiary
    : colors.statusComplete
  const quiet = !isActive && !selected && !unread && !woke && (status === null || status === 'Connecting' || status === 'Working' || status === 'Monitoring')
  const title = tab.customTitle || tab.title || 'Untitled'
  const worktreeTitle = tab.worktree ? inboxWorktreeFor(tab, benches, inventory).label : null
  const compact = variant === 'slim'
  const latestActivityAt = latestConversationActivityAt(tab)
  const rightLabel = compact && tab.snoozedUntil != null && tab.snoozedUntil > Date.now()
    ? availableSnoozePresets(new Date()).find((preset) => preset.until === tab.snoozedUntil)?.label ?? formatRelativeShort(tab.snoozedUntil)
    : latestActivityAt != null ? formatRelativeShort(latestActivityAt) : ''

  const commitRename = (): void => {
    const next = name.trim()
    if (next) useSessionStore.getState().renameTab(tab.id, next)
    setRenaming(false)
  }

  return (
    <ConversationHoverCard tab={tab} benches={benches} inventory={inventory} rightBoundaryRef={rightBoundaryRef}>
    <div
      {...handlers}
      data-inbox-tab-id={tab.id}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          onToggleSelected?.(event.shiftKey)
          return
        }
        if (!canRestore && tab.settledOverride === 'settled') return
        if (onOpen) onOpen(tab)
        else useSessionStore.getState().selectTab(tab.id)
      }}
      onDoubleClick={() => setRenaming(true)}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }) }}
      style={{
        display: 'flex', alignItems: compact ? 'center' : 'flex-start', gap: 7,
        padding: compact ? '5px 9px' : '8px 10px', cursor: 'pointer', borderRadius: 6,
        background: interactiveBg(colors, { hover, pressed }, isActive || selected ? colors.accentLight : 'transparent'),
        opacity: quiet ? (hover ? 1 : 0.62) : 1, transition: `background ${transitions.base}, opacity ${transitions.base}`,
        fontFamily: 'system-ui, sans-serif', minWidth: 0, width: '100%', boxSizing: 'border-box',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          {tab.pinnedAt != null && <PushPin size={12} color={colors.textTertiary} weight="fill" />}
          {renaming ? (
            <input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} onBlur={commitRename}
              onKeyDown={(event) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(false) }}
              style={{ minWidth: 0, flex: 1, fontSize: compact ? 11 : 12, color: colors.textPrimary, background: colors.surfacePrimary, border: `1px solid ${colors.accent}`, borderRadius: 3 }} />
          ) : <span style={{ fontSize: compact ? 11 : 12, fontWeight: unread || isActive || selected ? 600 : 400, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>}
        </div>
        {!compact && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, marginTop: 2, color: colors.textTertiary, fontSize: 10 }}>
            {projectName && <span style={{ background: colors.surfacePrimary, padding: '0 4px', borderRadius: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectName}</span>}
            {worktreeTitle && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{worktreeTitle}</span>}
            {tab.worktree?.branchName && tab.worktree.branchName !== worktreeTitle && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.worktree.branchName}</span>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, paddingTop: compact ? 0 : 1 }}>
        {tab.settledOverride === 'auto' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9, color: colors.textTertiary }}><ClockCounterClockwise size={10} />Auto</span>}
        {woke && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9, color: colors.statusPermission }}><WarningCircle size={11} />Woke</span>}
        {status ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9, fontWeight: 600, color: statusColor }}>
          {status === 'Done' && <Check size={11} />}{status}
        </span> : null}
        {rightLabel && <span style={{ fontSize: 9, color: colors.textTertiary }}>{rightLabel}</span>}
        {hover && !compact && tab.pinnedAt == null && <button onClick={(event) => { event.stopPropagation(); void useSessionStore.getState().settleTab(tab.id) }} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', borderRadius: 4, background: colors.surfacePrimary, color: colors.textSecondary, cursor: 'pointer', padding: '3px 5px', fontSize: 10, fontWeight: 600 }} aria-label="Settle conversation"><Check size={13} />Settle</button>}
        {hover && tab.pinnedAt != null && <button onClick={(event) => { event.stopPropagation(); void useSessionStore.getState().unpinTab(tab.id) }} style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer' }} aria-label="Unpin conversation"><PushPinSlash size={14} /></button>}
        {hover && compact && variant === 'slim' && canRestore && <button onClick={(event) => {
          event.stopPropagation()
          if (tab.snoozedUntil != null && tab.snoozedUntil > Date.now()) void useSessionStore.getState().unsnoozeTab(tab.id)
          else void useSessionStore.getState().unsettleTab(tab.id, 'user')
        }} style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer' }} aria-label="Restore conversation"><ClockCounterClockwise size={14} /></button>}
      </div>
      {menu && <InboxRowMenu x={menu.x} y={menu.y} tab={tab} canRestore={canRestore} onRename={() => setRenaming(true)} onClose={() => setMenu(null)} />}
    </div>
    </ConversationHoverCard>
  )
}
