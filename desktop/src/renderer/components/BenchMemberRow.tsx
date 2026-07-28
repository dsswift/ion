/**
 * BenchMemberRow — one worktree layered onto the bench.
 *
 * The row's job is to make the pin visible. A member shows what is INTEGRATED
 * (its pinned sha), and separately whether the worktree has moved past it
 * (`stale`). Those are different facts, and collapsing them would hide the
 * central guarantee: the bench holds exactly what was pinned, so updating one
 * member cannot drag in another's half-finished work.
 *
 * A `pending` member shows `no commits yet` rather than a sha, because its pin
 * carries nothing: displaying `@abc1234` there would claim the bench holds a
 * contribution that does not exist.
 */
import React from 'react'
import { ArrowsClockwise, CircleNotch, Warning, X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import type { IntegrationMember } from '../../shared/types'

export function BenchMemberRow({
  member,
  busy,
  onToggleEnabled,
  onUpdate,
  onRemove,
  onOpen,
}: {
  member: IntegrationMember
  busy?: boolean
  onToggleEnabled(): void
  onUpdate(): void
  onRemove(): void
  onOpen(): void
}): React.JSX.Element {
  const colors = useColors()

  const statusColor =
    member.status === 'conflicted' ? colors.dangerFg
      : member.status === 'stale' ? colors.warningFg
        : member.status === 'missing' ? colors.textTertiary
          : member.status === 'excluded' ? colors.textTertiary
            : member.status === 'pending' ? colors.textTertiary
              : colors.worktreeGreen

  // Every status names itself. The previous `: member.pinnedSha ? '@sha'` tail
  // printed a bare pinned sha for any status it did not enumerate, which read as
  // "integrated at this commit" for states that hold nothing — exactly the wrong
  // claim for a member with no commits behind its pin.
  const statusLabel =
    member.status === 'conflicted' ? 'conflict'
      : member.status === 'missing' ? 'missing'
        : member.status === 'excluded' ? 'excluded'
          : member.status === 'pending' ? 'no commits yet'
            : member.status === 'landed' ? 'landed'
              : member.pinnedSha ? `@${member.pinnedSha.slice(0, 7)}` : ''

  const statusTooltip =
    member.status === 'stale' ? 'This worktree has committed work newer than what the bench holds'
      : member.status === 'conflicted' ? 'Could not merge; skipped so the rest of the bench still builds'
        : member.status === 'pending'
          ? 'Enrolled; nothing to integrate until this worktree has a commit'
          : member.status === 'missing' ? 'The branch or worktree is gone'
            : member.status === 'excluded' ? 'Excluded from the bench, so its merge is skipped'
              : member.status === 'landed' ? 'Landed into the feature branch; part of the bench base'
                : 'Integrated at this commit'

  return (
    <div
      data-testid={`bench-member-${member.branchName}`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 1,
        padding: '3px 6px', opacity: member.enabled ? 1 : 0.55,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {/* Enabled checkbox: excluding a member keeps it in the list but skips
            its merge, so the operator can bisect a broken build without
            dismantling the member set. */}
        <Tooltip text={member.enabled ? 'Included in the bench' : 'Excluded from the bench'}>
          <input
            type="checkbox"
            data-testid={`bench-enabled-${member.branchName}`}
            checked={member.enabled}
            onChange={onToggleEnabled}
            disabled={busy}
            style={{ width: 10, height: 10, cursor: 'pointer', flexShrink: 0 }}
          />
        </Tooltip>

        <button
          onClick={onOpen}
          style={{
            fontSize: 11, color: colors.textPrimary, fontWeight: 500,
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}
        >
          {member.label}
        </button>
        <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0 }}>{member.branchName}</span>

        <span style={{ flex: 1 }} />

        <Tooltip text={statusTooltip}>
          <span data-testid={`bench-status-${member.branchName}`} style={{ fontSize: 9, color: statusColor, flexShrink: 0 }}>
            {statusLabel}{member.status === 'stale' ? ' · stale' : ''}
          </span>
        </Tooltip>

        {member.status === 'stale' && (
          <Tooltip text="Update this member to its latest commit and rebuild">
            <button
              data-testid={`bench-update-${member.branchName}`}
              onClick={onUpdate}
              disabled={busy}
              style={{
                display: 'inline-flex', alignItems: 'center', padding: 0,
                background: 'transparent', border: 'none',
                color: colors.warningFg, cursor: busy ? 'default' : 'pointer', flexShrink: 0,
              }}
            >
              {busy ? <CircleNotch size={11} className="animate-spin" /> : <ArrowsClockwise size={11} />}
            </button>
          </Tooltip>
        )}

        <Tooltip text="Remove from the bench (the worktree is untouched)">
          <button
            data-testid={`bench-remove-${member.branchName}`}
            onClick={onRemove}
            disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 0,
              background: 'transparent', border: 'none',
              color: colors.textTertiary, cursor: busy ? 'default' : 'pointer', flexShrink: 0,
            }}
          >
            <X size={10} />
          </button>
        </Tooltip>
      </div>

      {/* Conflict detail inline: which files collided and with whom. A modal
          would hide it behind another click at the moment it is most needed. */}
      {member.status === 'conflicted' && (member.conflictPaths?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, paddingLeft: 15 }}>
          <Warning size={9} color={colors.dangerFg} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: colors.textTertiary }}>
            {member.conflictPaths!.slice(0, 3).join(', ')}
            {member.conflictPaths!.length > 3 ? ` +${member.conflictPaths!.length - 3} more` : ''}
            {(member.conflictsWith?.length ?? 0) > 0 && ` · conflicts with ${member.conflictsWith!.join(', ')}`}
          </span>
        </div>
      )}
    </div>
  )
}
