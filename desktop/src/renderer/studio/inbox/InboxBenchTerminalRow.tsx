import React, { useState } from 'react'
import { PushPin, Terminal, Globe, X } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { InboxBenchTerminalMenu } from './InboxBenchTerminalMenu'
import { Tooltip } from '../../components/git/Tooltip'
import { contentRouter } from '../../lib/file-open-router'

/**
 * The bench's dedicated terminal, rendered as its own occupant row beneath the
 * bench bar. It stays separate from InboxRow because terminal tabs have no
 * conversation lifecycle: close destroys the tab, while pin only controls
 * collapsed-group visibility.
 *
 * The row subscribes to terminal activity so close stays absent while a
 * foreground command runs. It also subscribes to active and pin state so
 * selection and persisted importance update without waiting for another Inbox
 * action. The context menu is terminal-only and never exposes settle, snooze,
 * unread, rename, or delete-conversation actions.
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
  const activity = useSessionStore((state) => [...state.terminalActivities.values()].find((item) => item.tabId === tabId && item.active) ?? null)
  const running = activity !== null
  const isActive = useSessionStore((state) => state.activeTabId === tabId)
  const pinned = useSessionStore((state) => state.tabs.find((tab) => tab.id === tabId)?.pinnedAt != null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <div
      data-testid={`inbox-bench-terminal-${sourceBranch}`}
      onClick={() => useSessionStore.getState().selectTab(tabId)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      {...handlers}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, width: '100%',
        padding: '5px 9px', cursor: 'pointer', borderRadius: 6, fontSize: 11,
        color: colors.textSecondary,
        background: interactiveBg(colors, { hover, pressed }, isActive ? colors.accentLight : 'transparent'),
        transition: `background ${transitions.base}`,
      }}
    >
      {pinned && <PushPin data-testid="bench-terminal-pin" size={12} color={colors.textTertiary} weight="fill" />}
      <Terminal size={13} />
      {running && <Tooltip text={activity?.applications[0] ? `${activity.processLabel ?? 'Web application'} — ${activity.applications[0].url}` : `${activity?.processLabel ?? 'Terminal command'} is running`}>
        {activity?.applications[0] ? <button aria-label={`Open ${activity.applications[0].url}`} onClick={(event) => {
          event.stopPropagation()
          const app = activity.applications[0]
          const router = contentRouter()
          if (router?.openWebApplication) router.openWebApplication(tabId, app.url)
          else void window.ion.openExternal(app.url)
        }} style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: colors.statusBash, cursor: 'pointer', padding: 0 }}><Globe size={12} /></button>
          : <Terminal size={12} weight="fill" color={colors.statusBash} aria-label="Running terminal command" />}
      </Tooltip>}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActive ? 600 : 400 }}>{label}</span>
      {hover && !running && (
        <button
          aria-label="Close terminal"
          onClick={(event) => { event.stopPropagation(); useSessionStore.getState().closeTab(tabId) }}
          style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', padding: 0, flexShrink: 0 }}
        ><X size={12} /></button>
      )}
      {menu && <InboxBenchTerminalMenu anchor={menu} tabId={tabId} pinned={pinned} onClose={() => setMenu(null)} />}
    </div>
  )
}
