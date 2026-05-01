import React from 'react'
import { useColors } from '../theme'
import type { TabStatus, TabState } from '../../shared/types'
import { PILL_ICON_MAP, getTabStatusColor, type WaitingState } from './TabStripShared'

interface StatusDotProps {
  status: TabStatus
  hasUnread: boolean
  hasPermission: boolean
  bashExecuting: boolean
  waitingState: WaitingState
  pillIcon?: string | null
}

/** Single status dot/icon for one tab pill. Color, pulse and glow reflect the live tab state. */
export function StatusDot({ status, hasUnread, hasPermission, bashExecuting, waitingState, pillIcon }: StatusDotProps) {
  const colors = useColors()
  let bg: string = colors.statusIdle
  let pulse = false
  let glow = false
  let glowColor = colors.statusPermissionGlow

  if (status === 'dead' || status === 'failed') {
    bg = colors.statusError
  } else if (hasPermission) {
    bg = colors.statusPermission
    glow = true
  } else if (waitingState === 'plan-ready') {
    bg = colors.statusComplete
    glow = true
    glowColor = colors.tabGlowPlanReady
  } else if (waitingState === 'question') {
    bg = colors.infoText
    glow = true
    glowColor = colors.tabGlowQuestion
  } else if (status === 'connecting' || status === 'running') {
    bg = colors.statusRunning
    pulse = true
  } else if (bashExecuting) {
    bg = colors.statusBash
    pulse = true
    glow = true
    glowColor = colors.statusBashGlow
  } else if (hasUnread) {
    bg = colors.statusComplete
  }

  const IconComponent = pillIcon ? PILL_ICON_MAP[pillIcon] : null
  if (IconComponent) {
    return (
      <span
        className={`flex-shrink-0 inline-flex items-center justify-center ${pulse ? 'animate-pulse-dot' : ''}`}
        style={{ width: 8, height: 8, ...(glow ? { filter: `drop-shadow(0 0 4px ${glowColor})` } : {}) }}
      >
        <IconComponent size={8} weight="fill" color={bg} />
      </span>
    )
  }

  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
      }}
    />
  )
}

/** Stacked status dots used inside group pills — one dot per non-terminal conversation tab, capped at 5 with overflow. */
export function StackedStatusDots({ tabs }: { tabs: TabState[] }) {
  const colors = useColors()
  const conversationTabs = tabs.filter((t) => !t.isTerminalOnly)
  const maxVisible = 5
  const visible = conversationTabs.slice(0, maxVisible)
  const overflow = conversationTabs.length - maxVisible

  return (
    <div className="flex items-center flex-shrink-0" style={{ marginRight: 2 }}>
      {visible.map((tab, i) => {
        const { bg, pulse, glow, glowColor } = getTabStatusColor(tab, colors)
        return (
          <span
            key={tab.id}
            className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
            style={{
              background: bg,
              marginLeft: i === 0 ? 0 : -3,
              zIndex: maxVisible - i,
              position: 'relative',
              ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
            }}
          />
        )
      })}
      {overflow > 0 && (
        <span
          className="text-[8px] flex-shrink-0"
          style={{ color: colors.textTertiary, marginLeft: 2 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}
