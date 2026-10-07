/** The trailing status word an Inbox row shows, or null for none. */
export type InboxRowStatus =
  | 'Approval' | 'Plan Ready' | 'Input' | 'Limited' | 'Failed'
  | 'Connecting' | 'Monitoring' | 'Working' | 'Done'

/**
 * How loudly an Inbox row speaks. A busy conversation recedes furthest: the
 * person should see that it is working and then look elsewhere. A read, idle
 * row recedes a little. A row that asks something of the person stays full.
 */
export type InboxRowEmphasis = 'full' | 'quiet' | 'working'

export const INBOX_ROW_OPACITY: Readonly<Record<InboxRowEmphasis, number>> = {
  full: 1,
  quiet: 0.62,
  working: 0.45,
}

export function inboxRowEmphasis(row: {
  status: InboxRowStatus | null
  /** The open conversation, or one in the multi-selection. */
  focused: boolean
  unread: boolean
  woke: boolean
  /** A prompt waits for the usage limit to lift. */
  held: boolean
}): InboxRowEmphasis {
  if (row.focused || row.woke) return 'full'
  if (row.status === 'Working' || row.status === 'Monitoring' || row.status === 'Connecting') return 'working'
  if (row.unread) return 'full'
  return row.status === null || (row.status === 'Limited' && row.held) ? 'quiet' : 'full'
}
