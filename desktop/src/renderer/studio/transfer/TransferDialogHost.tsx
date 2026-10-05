/**
 * The one Transfer dialog, owned by the window rather than by whatever opened it.
 *
 * A transfer moves the very thing its opener belongs to. The inbox row and
 * the worktree row that offer Transfer all stand for a
 * conversation or worktree on one machine, and a finished move deletes that
 * copy and adds one on the destination. A dialog rendered inside the opener
 * dies with it, or, when React reuses or strands the opener's component,
 * lingers as a full-window backdrop whose Done button no longer re-renders.
 *
 * So openers only ask. `openTransferDialog` records the request here, the
 * opener closes its own menu straight away, and `TransferDialogHost` (mounted
 * once in the Studio shell) renders the dialog until the operator dismisses it.
 */
import React, { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { rInfo } from '../../rendererLogger'
import { TransferDialog } from './TransferDialog'
import type { TransferMode } from './useTransferPreflight'

export interface TransferDialogRequest {
  tabId: string
  initialMode: TransferMode
  /** The machine the dialog opens on as its destination, when the opener has one in mind. The operator can still change it. */
  suggestedEnvironmentId?: string
}

interface OpenDialog extends TransferDialogRequest {
  /** Fresh per open, so a second request remounts the dialog with clean state. */
  key: number
}

let current: OpenDialog | null = null
let nextKey = 1
const listeners = new Set<() => void>()

function publish(next: OpenDialog | null): void {
  current = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function snapshot(): OpenDialog | null {
  return current
}

/** Open the Transfer dialog for a conversation. Replaces any dialog already open. */
export function openTransferDialog(request: TransferDialogRequest): void {
  rInfo('transfer.dialog', 'transfer dialog requested', {
    tab_id: request.tabId.slice(0, 8),
    mode: request.initialMode,
    replaced: current !== null,
  })
  publish({ ...request, key: nextKey++ })
}

function closeTransferDialog(): void {
  if (!current) return
  rInfo('transfer.dialog', 'transfer dialog dismissed', { tab_id: current.tabId.slice(0, 8) })
  publish(null)
}

/** Mounted once in the Studio shell. Renders nothing until a transfer is requested. */
export function TransferDialogHost(): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribe, snapshot, snapshot)
  const layer = usePopoverLayer()
  if (!open || !layer) return null
  return createPortal(
    <TransferDialog key={open.key} tabId={open.tabId} initialMode={open.initialMode} suggestedEnvironmentId={open.suggestedEnvironmentId} onClose={closeTransferDialog} />,
    layer,
  )
}
