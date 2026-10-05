/**
 * WorktreeEphemeralBadge — marks a worktree that closes with its conversation.
 *
 * Two states, both read straight off the inventory entry:
 * - `ephemeral`: the worktree is removed when the conversation it was cut for
 *   closes, unless it holds unlanded work.
 * - `ephemeralKeptReason`: that close kept it as an ordinary worktree; the
 *   tooltip says why.
 * Renders nothing for an ordinary worktree.
 */
import React from 'react'
import { Timer } from '@phosphor-icons/react'
import type { WorktreeInventoryEntry } from '@ion/shared/types'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'

export const EPHEMERAL_TOOLTIP = 'Ephemeral: removed when its conversation closes, unless it holds work that has not landed.'

export function WorktreeEphemeralBadge({ entry }: {
  entry: Pick<WorktreeInventoryEntry, 'branchName' | 'ephemeral' | 'ephemeralKeptReason'>
}): React.JSX.Element | null {
  const colors = useColors()
  if (!entry.ephemeral && !entry.ephemeralKeptReason) return null
  const kept = !entry.ephemeral
  const text = kept ? `Kept when its conversation closed: ${entry.ephemeralKeptReason}` : EPHEMERAL_TOOLTIP
  return (
    <Tooltip text={text}>
      <span
        data-testid={`worktree-ephemeral-${entry.branchName}`}
        data-kept={kept}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
          fontSize: 9, color: kept ? colors.warningFg : colors.textTertiary,
        }}
      >
        <Timer size={10} weight={kept ? 'regular' : 'fill'} />
        {kept ? 'kept' : 'ephemeral'}
      </span>
    </Tooltip>
  )
}
