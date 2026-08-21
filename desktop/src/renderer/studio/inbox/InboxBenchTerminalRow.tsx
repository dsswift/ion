import React from 'react'
import { Terminal, X } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'

/**
 * The bench's dedicated terminal, rendered as its own occupant row beneath
 * the bench bar (see InboxNavigatorGroups.tsx). Pulled into its own component
 * -- rather than inlined in that file's render loop -- because it needs
 * `useInteractiveState()` for a real hover affordance and a live subscription
 * to `terminalActiveTabIds` for the close gate below, and neither can be
 * called conditionally inside a loop (Rules of Hooks).
 *
 * Close is intentionally NOT the settle/un-settle flow the conversation rows
 * use: a terminal-only tab has no Settled History entry to return to (see
 * `closeTab` in tab-slice.ts -- `isTerminalOnly` skips that routing entirely
 * and tears the tab down for good), so "close" here just removes the tab.
 * Gated on the terminal being idle: killing a running foreground process out
 * from under the operator with one click is the same footgun `closeBlocked`
 * on the tab strip's X exists to prevent, and `terminalActiveTabIds` is the
 * same live signal that predicate reads (via `isAnyTerminalCommandRunning`
 * elsewhere) -- subscribed directly here so the row re-renders when this
 * tab's activity flips.
 */
export function InboxBenchTerminalRow({
  tabId,
  sourceBranch,
  label,
}: {
  tabId: string
  sourceBranch: string
  label: string
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const running = useSessionStore((state) => state.terminalActiveTabIds.has(tabId))
  // Same "is this the active tab" check InboxRow does for a conversation row —
  // without it, selecting the bench terminal made it the active conversation
  // but the row itself never showed the persistent accent highlight every
  // other selected row gets, so a click appeared to do nothing.
  const isActive = useSessionStore((state) => state.activeTabId === tabId)

  return (
    <div
      data-testid={`inbox-bench-terminal-${sourceBranch}`}
      onClick={() => useSessionStore.getState().selectTab(tabId)}
      {...handlers}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, width: '100%',
        padding: '5px 9px', cursor: 'pointer', borderRadius: 6, fontSize: 11,
        color: colors.textSecondary,
        background: interactiveBg(colors, { hover, pressed }, isActive ? colors.accentLight : 'transparent'),
        transition: `background ${transitions.base}`,
      }}
    >
      <Terminal size={13} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActive ? 600 : 400 }}>{label}</span>
      {hover && !running && (
        <button
          aria-label="Close terminal"
          onClick={(event) => { event.stopPropagation(); useSessionStore.getState().closeTab(tabId) }}
          style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', padding: 0, flexShrink: 0 }}
        ><X size={12} /></button>
      )}
    </div>
  )
}
