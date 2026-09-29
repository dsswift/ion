/**
 * useTransferGate — whether a menu's Transfer row is enabled: only when the
 * tab is idle and not already mid-transfer.
 *
 * It does not ask whether another environment is connected. A conversation
 * can move within the machine it is on — into another checkout or worktree
 * there — so the machine it is on is always a destination. The dialog says
 * when a whole-worktree move has nowhere to go.
 *
 * The row itself always shows. It used to be hidden on a tab that had
 * already been transferred away, which no longer exists — a transfer
 * deletes the copy it moved.
 *
 * A hook so the row menu reads it as one plain value, as it does
 * `useConvertToWorktreeGate.ts`.
 */
import type { TabState } from '@ion/shared/types'

export interface TransferGate {
  /** Whether the row is present but refuses to run. */
  disabled: boolean
}

/** Resolves the Transfer row's enablement for `tab`. */
export function useTransferGate(tab: Pick<TabState, 'status' | 'sealPending'>): TransferGate {
  return { disabled: tab.status !== 'idle' || !!tab.sealPending }
}
