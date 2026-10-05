import React, { useCallback, useEffect, useState } from 'react'
import { GitBranch } from '@phosphor-icons/react'
import type { ConversationBranch, ConversationBranches } from '@ion/shared/conversation-branches'
import { host } from '../../host/host-instance'
import { useColors } from '../../theme'
import { Tooltip } from '../git/Tooltip'
import { rInfo, rWarn } from '../../rendererLogger'
import { formatRunDuration } from './RunDurationFooter'

interface Props {
  tabId: string
  /** Re-reads the branches whenever the transcript changes length. */
  messageCount: number
  isRunning: boolean
}

function branchAge(timestamp: number): string {
  return `${formatRunDuration(Date.now() - timestamp)} ago`
}

/**
 * The conversation's other paths. Shown at the end of the transcript only
 * when the tree holds more than one branch (a rewind left the old path on
 * disk). Clicking a branch makes it the active path; the new transcript
 * arrives with the engine's active-path event, not from this component.
 */
export function BranchSwitcher({ tabId, messageCount, isRunning }: Props) {
  const colors = useColors()
  const [listing, setListing] = useState<ConversationBranches | null>(null)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    host.shell.engineListBranches(tabId)
      .then(setListing)
      .catch((err: unknown) => {
        rWarn('conversation.branches', 'list branches failed', { tab_id: tabId, error: String(err) })
        setListing(null)
      })
  }, [tabId])

  useEffect(() => {
    if (isRunning) return
    refresh()
  }, [refresh, isRunning, messageCount])

  const switchTo = (branch: ConversationBranch) => {
    if (branch.active || switching) return
    setSwitching(branch.leafId)
    setError(null)
    host.shell.engineSwitchBranch(tabId, branch.leafId)
      .then(() => {
        rInfo('conversation.branches', 'switched branch', { tab_id: tabId, leaf_id: branch.leafId })
        setOpen(false)
        refresh()
      })
      .catch((err: unknown) => {
        rWarn('conversation.branches', 'switch branch failed', { tab_id: tabId, leaf_id: branch.leafId, error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setSwitching(null))
  }

  if (isRunning || !listing || listing.branches.length < 2) return null
  const branches = [...listing.branches].sort((a, b) => b.timestamp - a.timestamp)

  return (
    <div data-testid="branch-switcher" style={{ padding: '4px 0 4px 22px', fontSize: 11 }}>
      <Tooltip text="This conversation has other paths from an earlier rewind">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md cursor-pointer"
          style={{ background: 'transparent', border: 'none', color: colors.textTertiary }}
        >
          <GitBranch size={11} />
          <span>{branches.length} branches</span>
        </button>
      </Tooltip>
      {open && (
        <div role="list" style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {branches.map((b) => (
            <button
              key={b.leafId}
              role="listitem"
              onClick={() => switchTo(b)}
              disabled={b.active || switching !== null}
              className="text-left px-2 py-1 rounded-md cursor-pointer disabled:cursor-default"
              style={{
                background: b.active ? colors.surfaceHover : 'transparent',
                border: `1px solid ${colors.containerBorder}`,
                color: colors.textPrimary,
                opacity: switching && switching !== b.leafId ? 0.5 : 1,
              }}
              aria-label={b.active ? 'The current path' : 'Continue from this path'}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {b.preview || '(no text)'}
              </div>
              <div style={{ color: colors.textTertiary, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                {b.active ? 'Current · ' : switching === b.leafId ? 'Switching… · ' : ''}
                {b.messageCount} messages · {branchAge(b.timestamp)}
              </div>
            </button>
          ))}
          {error && <div style={{ color: colors.statusError, fontSize: 10 }}>{error}</div>}
        </div>
      )}
    </div>
  )
}
