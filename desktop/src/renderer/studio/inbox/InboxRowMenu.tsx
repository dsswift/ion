/**
 * InboxRowMenu — context menu for an inbox row: Snooze ▸ presets, Mark
 * unread, Settle/Un-settle, Rename (with or without the worktree), Transfer, and confirmed permanent
 * deletion. The inbox is the primary conversation surface, so a conversation
 * verb lands here.
 */
import { tabEnvironmentId } from '../connection/tab-environment'
import { isNonNegativeNumber, useServerSetting } from '../state/use-server-setting'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isTabWorktreeSealed } from '@ion/shared/worktree-seal'
import { Trash } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from '../../components/git/ConfirmDialog'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useColors } from '../../theme'
import { rInfo, rWarn, rError } from '../../rendererLogger'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { availableSnoozePresets } from './inbox-snooze-presets'
import { isBenchDirectory, settlingIsPermanent } from '@ion/shared/worktree-conversations'
import { classifyInbox, type InboxTabView } from '@ion/shared/inbox-classify'
import type { TabState } from '@ion/shared/types'
import { scrollableMenuStyle } from '../../menu-viewport'
import { useConvertToWorktreeGate } from '../../components/useConvertToWorktreeGate'
import { useTransferGate } from '../transfer/useTransferGate'
import { openTransferDialog } from '../transfer/TransferDialogHost'
import { copyConversationSessionIds, copyConversationTranscript } from '../../copy-conversation'

function MenuButton({ label, onSelect, disabled = false, icon, danger = false }: { label: string; onSelect: () => void; disabled?: boolean; icon?: React.ReactNode; danger?: boolean }): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      className="ion-focusable"
      {...handlers}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '5px 12px',
        border: 'none',
        background: disabled ? 'transparent' : interactiveBg(colors, { hover, pressed }),
        gap: 7,
        color: disabled ? colors.textTertiary : danger ? colors.dangerFg : colors.textPrimary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        textAlign: 'left',
        fontSize: 12,
        transition: `background ${transitions.base}`,
      }}
    >
      {icon}
      {label}
    </button>
  )
}

export function InboxRowMenu({ x, y, tab, canRestore = true, onRename, onRenameWithWorktree, onPickColor, onClose }: { x: number; y: number; tab: TabState; canRestore?: boolean; onRename: () => void; /** Renames the conversation AND its worktree. Offered only for a worktree conversation. */ onRenameWithWorktree?: () => void; /** Opens the color picker for this conversation. */ onPickColor?: () => void; onClose: () => void }): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The auto-settle window of the server this conversation is on.
  const autoSettleDays = useServerSetting(tabEnvironmentId(tab), 'inboxAutoSettleDays', isNonNegativeNumber, 0)

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest('[data-ion-confirm]')) return
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !confirmDelete) onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [confirmDelete, onClose])

  const presets = useMemo(() => availableSnoozePresets(new Date()), [])
  // A bench conversation is ephemeral: the next assembly recreates the bench
  // branch and deletes it, so parking one for later promises a future that
  // cannot arrive. The store refuses the action; the verb is ABSENT here rather
  // than disabled, matching how every other unavailable affordance is treated.
  // Settling an ephemeral role is terminal, and the verb says so: the operator
  // is choosing to end the conversation, not to shelve it. Un-settle is already
  // absent for these records (`canRestore`), so an unlabeled "Settle" would be
  // the one action whose consequence is invisible until it is irreversible.
  const settlesPermanently = settlingIsPermanent(tab.tabRole)
  const benchPaths = useSessionStore((state) => state.benchWorkspaces)
  const inBench = isBenchDirectory(
    tab.workingDirectory,
    [...benchPaths.values()].flatMap((list) => list.map((workspace) => workspace.benchPath)),
  )
  // Visible only for a plain conversation over a git repo (not already a
  // worktree), disabled while the tab is busy or the checkout is dirty.
  const convert = useConvertToWorktreeGate(tab)
  // "Fork conversation" needs a
  // minted conversation to copy from, and a landed or moved worktree is a
  // sealed read-only record that no longer accepts new forks.
  const canFork = !!tab.conversationId && !isTabWorktreeSealed(tab)
  // "Transfer…" is disabled
  // unless the conversation is idle, not already mid-transfer, and some
  // other environment is connected to receive it.
  const transfer = useTransferGate(tab)

  // Settled state (override-aware) decides which settle verb shows.
  const view: InboxTabView = {
    status: tab.status,
    settledOverride: tab.settledOverride,
    settledAt: tab.settledAt,
    snoozedUntil: tab.snoozedUntil,
    snoozedAt: tab.snoozedAt,
    lastVisitedAt: tab.lastVisitedAt,
    lastCompletionAt: tab.lastCompletionAt,
    lastActivityAt: tab.lastActivityAt,
    manualUnread: tab.manualUnread,
    pendingAskCount: 0,
    waiting: false,
    failed: tab.status === 'failed',
  }
  const state = classifyInbox(view, Date.now(), autoSettleDays > 0 ? autoSettleDays : null)
  const canSettleInstead = state !== 'settled' && !settlesPermanently
  const exec = (fn: () => void): void => {
    fn()
    onClose()
  }
  const store = useSessionStore

  const showPinAction = !inBench || tab.pinnedAt != null
  // Drives the anchored positioner's re-measure. A bench row drops Snooze and
  // an unpinned bench conversation drops Pin; the convert row is conditional.
  const itemCount = 5
    - (inBench && state !== 'snoozed' ? 1 : 0)
    - (showPinAction ? 0 : 1)
    + (snoozeOpen ? presets.length : 0)
    + (convert.show ? 1 : 0)
    + (canFork ? 1 : 0)
    + (onPickColor ? 1 : 0)
    + 1
  const pos = useAnchoredPopover({ x, y }, { deps: [itemCount, convert.label] })

  const menu = (
    <div
      ref={(node) => {
        ;(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-ion-ui
      // This menu is DECLARED inside the row element and portals into
      // PopoverLayer. A portal relocates the DOM node but not the React event
      // path, so a synthetic click in here still bubbles to the row's own
      // onClick/onDoubleClick — which selected the conversation the operator was
      // only right-clicking, and started an inline rename on a double click.
      // Contain the menu's own events; the row's plain-click selection is
      // untouched because that click never passes through here.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width: 210,
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: '4px 0',
        zIndex: 99999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      {state === 'snoozed' ? (
        <MenuButton label="Wake" onSelect={() => exec(() => store.getState().unsnoozeTab(tab.id))} />
      ) : inBench ? null : (
        <MenuButton label={snoozeOpen ? 'Snooze ▾' : 'Snooze ▸'} onSelect={() => setSnoozeOpen((v) => !v)} />
      )}
      {snoozeOpen &&
        presets.map((p) => (
          <div key={p.id} style={{ paddingLeft: 12 }}>
            <MenuButton label={p.label} onSelect={() => exec(() => store.getState().snoozeTab(tab.id, p.until))} />
          </div>
        ))}
      <MenuButton label="Mark unread" onSelect={() => exec(() => store.getState().markTabUnread(tab.id))} />
      {showPinAction && <MenuButton label={tab.pinnedAt != null ? 'Unpin conversation' : 'Pin conversation'} onSelect={() => exec(() => {
        if (tab.pinnedAt != null) store.getState().unpinTab(tab.id)
        else if (!store.getState().pinTab(tab.id)) rWarn('inbox', 'pin request refused', { tab_id: tab.id.slice(0, 8) })
      })} />}
      {state === 'settled' ? (
        canRestore ? <MenuButton label="Un-settle" onSelect={() => exec(() => { void store.getState().unsettleTab(tab.id, 'user') })} /> : null
      ) : (
        <MenuButton label={settlesPermanently ? 'Settle permanently' : 'Settle'} onSelect={() => exec(() => { void store.getState().settleTab(tab.id) })} />
      )}
      <div style={{ height: 1, background: colors.containerBorder, margin: '4px 0' }} />
      <MenuButton label="Rename" onSelect={() => exec(onRename)} />
      {/* Worktree conversations only: the deliberate "change both names" verb.
          Plain Rename leaves the worktree alone, because a worktree's topic
          does not follow every conversation relabelling. */}
      {onRenameWithWorktree && tab.worktree && <MenuButton label="Rename conversation and worktree…" onSelect={() => exec(onRenameWithWorktree)} />}
      {onPickColor && <MenuButton label="Color…" onSelect={() => exec(onPickColor)} />}
      <MenuButton label="Regenerate title" onSelect={() => exec(() => { void store.getState().regenerateTabTitle(tab.id) })} />
      {canFork && (
        <MenuButton
          label="Fork conversation"
          onSelect={() => exec(() => {
            void store.getState().forkTab(tab.id).catch((err) => rError('inbox', 'fork tab failed', { error: String(err) }))
          })}
        />
      )}
      {convert.show && (
        <MenuButton
          label={convert.label}
          disabled={convert.disabled}
          onSelect={() => exec(() => {
            void store.getState().convertToWorktree(tab.id).catch((err) => rError('inbox', 'convert to worktree failed', { error: String(err) }))
          })}
        />
      )}
      <MenuButton
        label="Transfer…"
        disabled={transfer.disabled}
        onSelect={() => exec(() => {
          rInfo('inbox', 'transfer dialog opened', { tab_id: tab.id.slice(0, 8) })
          openTransferDialog({ tabId: tab.id, initialMode: 'conversation' })
        })}
      />
      <MenuButton label="Copy path" onSelect={() => exec(() => { void navigator.clipboard.writeText(tab.workingDirectory).catch((error) => rWarn('inbox', 'copy path failed', { error: String(error) })) })} />
      {tab.worktree?.branchName && <MenuButton label="Copy branch" onSelect={() => exec(() => { void navigator.clipboard.writeText(tab.worktree!.branchName).catch((error) => rWarn('inbox', 'copy branch failed', { error: String(error) })) })} />}
      {!tab.isTerminalOnly && <MenuButton label="Copy transcript" onSelect={() => exec(() => { void copyConversationTranscript(tab.id) })} />}
      {!tab.isTerminalOnly && <MenuButton label="Copy session ID" disabled={!tab.conversationId && !tab.lastKnownSessionId && tab.historicalSessionIds.length === 0} onSelect={() => exec(() => { void copyConversationSessionIds(tab) })} />}
      <MenuButton
        label="Delete conversation…"
        icon={<Trash size={14} weight="bold" />}
        danger
        onSelect={() => {
          rInfo('inbox', 'conversation delete confirmation opened', { tab_id: tab.id.slice(0, 8) })
          setConfirmDelete(true)
        }}
      />
    </div>
  )
  const dialog = confirmDelete ? (
    <ConfirmDialog
      title="Delete conversation?"
      message="This permanently deletes the stored conversation. Settle keeps it in history so you can return to it later."
      cancelLabel="Cancel"
      alternateLabel={canSettleInstead ? 'Settle Conversation' : undefined}
      onAlternate={canSettleInstead ? () => {
        rInfo('inbox', 'conversation delete replaced with settlement', { tab_id: tab.id.slice(0, 8) })
        setConfirmDelete(false)
        void store.getState().settleTab(tab.id)
        onClose()
      } : undefined}
      confirmLabel="Delete Conversation"
      initialFocus="cancel"
      danger
      onConfirm={() => {
        rInfo('inbox', 'conversation permanent deletion confirmed', { tab_id: tab.id.slice(0, 8) })
        setConfirmDelete(false)
        void store.getState().deleteConversationTab(tab.id)
        onClose()
      }}
      onCancel={() => {
        rInfo('inbox', 'conversation permanent deletion cancelled', { tab_id: tab.id.slice(0, 8) })
        setConfirmDelete(false)
      }}
    />
  ) : null
  const content = confirmDelete && dialog ? dialog : menu
  return layer ? createPortal(content, layer) : content
}
