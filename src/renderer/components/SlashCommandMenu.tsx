import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  Trash, Cpu, CurrencyDollar, Question, HardDrives, Sparkle,
} from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

export interface SlashCommand {
  command: string
  description: string
  icon: React.ReactNode
  group?: 'builtin' | 'user' | 'project'
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/clear', description: 'Clear conversation history', icon: <Trash size={13} />, group: 'builtin' },
  { command: '/cost', description: 'Show token usage and cost', icon: <CurrencyDollar size={13} />, group: 'builtin' },
  { command: '/model', description: 'Show current model info', icon: <Cpu size={13} />, group: 'builtin' },
  { command: '/mcp', description: 'Show MCP server status', icon: <HardDrives size={13} />, group: 'builtin' },
  { command: '/skills', description: 'Show available skills', icon: <Sparkle size={13} />, group: 'builtin' },
  { command: '/help', description: 'Show available commands', icon: <Question size={13} />, group: 'builtin' },
]

const GROUP_ORDER: Record<string, number> = { builtin: 0, project: 1, user: 2 }
const GROUP_LABELS: Record<string, string> = { project: 'Project', user: 'User' }

interface Props {
  filter: string
  selectedIndex: number
  onSelect: (cmd: SlashCommand) => void
  anchorRect: DOMRect | null
  extraCommands?: SlashCommand[]
}

export function getFilteredCommands(filter: string): SlashCommand[] {
  return getFilteredCommandsWithExtras(filter, [])
}

export function getFilteredCommandsWithExtras(filter: string, extraCommands: SlashCommand[]): SlashCommand[] {
  const q = filter.toLowerCase()
  const merged: SlashCommand[] = [...SLASH_COMMANDS]
  for (const cmd of extraCommands) {
    if (!merged.some((c) => c.command === cmd.command)) {
      merged.push(cmd)
    }
  }
  const filtered = merged.filter((c) => c.command.startsWith(q))
  filtered.sort((a, b) => {
    const groupDiff = (GROUP_ORDER[a.group || 'builtin'] || 0) - (GROUP_ORDER[b.group || 'builtin'] || 0)
    if (groupDiff !== 0) return groupDiff
    return a.command.localeCompare(b.command)
  })
  return filtered
}

export function SlashCommandMenu({ filter, selectedIndex, onSelect, anchorRect, extraCommands = [] }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const popoverLayer = usePopoverLayer()
  const filtered = getFilteredCommandsWithExtras(filter, extraCommands)
  const colors = useColors()

  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.querySelector(`[data-cmd-idx="${selectedIndex}"]`) as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (filtered.length === 0 || !anchorRect || !popoverLayer) return null

  return createPortal(
    <motion.div
      data-clui-ui
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        bottom: window.innerHeight - anchorRect.top + 4,
        left: anchorRect.left + 12,
        right: window.innerWidth - anchorRect.right + 12,
        pointerEvents: 'auto',
      }}
    >
      <div
        ref={listRef}
        className="overflow-y-auto rounded-xl py-1"
        style={{
          maxHeight: 280,
          background: colors.popoverBg,
          backdropFilter: 'blur(20px)',
          border: `1px solid ${colors.popoverBorder}`,
          boxShadow: colors.popoverShadow,
        }}
      >
        {filtered.map((cmd, i) => {
          const isSelected = i === selectedIndex
          const prevGroup = i > 0 ? (filtered[i - 1].group || 'builtin') : null
          const currentGroup = cmd.group || 'builtin'
          const showHeader = currentGroup !== 'builtin' && currentGroup !== prevGroup

          return (
            <React.Fragment key={cmd.command}>
              {showHeader && (
                <div
                  className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wider font-medium"
                  style={{ color: colors.textTertiary }}
                >
                  {GROUP_LABELS[currentGroup] || currentGroup}
                </div>
              )}
              <button
                data-cmd-idx={i}
                onClick={() => onSelect(cmd)}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
                style={{
                  background: isSelected ? colors.accentLight : 'transparent',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = colors.accentLight
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent'
                  }
                }}
              >
                <span
                  className="flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0"
                  style={{
                    background: isSelected ? colors.accentSoft : colors.surfaceHover,
                    color: isSelected ? colors.accent : colors.textTertiary,
                  }}
                >
                  {cmd.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <span
                    className="text-[12px] font-mono font-medium"
                    style={{ color: isSelected ? colors.accent : colors.textPrimary }}
                  >
                    {cmd.command}
                  </span>
                  <span
                    className="text-[11px] ml-2"
                    style={{ color: colors.textTertiary }}
                  >
                    {cmd.description}
                  </span>
                </div>
              </button>
            </React.Fragment>
          )
        })}
      </div>
    </motion.div>,
    popoverLayer,
  )
}
