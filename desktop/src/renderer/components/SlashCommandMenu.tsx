import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Trash, PuzzlePiece, Broom, DownloadSimple } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useInteractiveState } from '../hooks/useInteractiveState'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { transitions } from '../theme-tokens'
import { zoomRect, zoomViewport } from '../viewport-zoom'
import { fuzzyFilterAndSort } from '../../shared/fuzzy-match'

export interface SlashCommand {
  command: string
  description: string
  icon: React.ReactNode
  group?: 'builtin' | 'project' | 'extension' | 'user'
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/clear', description: 'Clear conversation history', icon: <Trash size={13} />, group: 'builtin' },
  { command: '/clear --keep-plan', description: 'Clear history but keep the active plan in context', icon: <Trash size={13} />, group: 'builtin' },
  { command: '/compact', description: 'Summarize older turns and free context', icon: <Broom size={13} />, group: 'builtin' },
  { command: '/export', description: 'Export conversation as Markdown', icon: <DownloadSimple size={13} />, group: 'builtin' },
]

/** Icon used for extension-registered commands in the slash menu. */
export const ExtensionCommandIcon = () => <PuzzlePiece size={13} />


const GROUP_LABELS: Record<string, string> = { project: 'Project', extension: 'Extension', user: 'User' }

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
  const merged: SlashCommand[] = [...SLASH_COMMANDS]
  for (const cmd of extraCommands) {
    if (!merged.some((c) => c.command === cmd.command)) {
      merged.push(cmd)
    }
  }
  return fuzzyFilterAndSort(filter, merged)
}

/**
 * Decide what pressing Enter does while the slash menu is open.
 *
 *  - 'complete' — the typed filter matches at least one known command; Enter
 *    completes the highlighted entry from the menu.
 *  - 'send'     — the typed text matches NO known command; Enter must close the
 *    menu and submit the raw text so the prompt pipeline forwards it to the
 *    engine (resolveSlash) which resolves the template or surfaces "Unknown
 *    command". Returning 'send' here is what prevents an unknown/typed slash
 *    command from being unsendable (the menu must not swallow Enter).
 */
export function slashMenuEnterAction(filteredCount: number): 'complete' | 'send' {
  return filteredCount > 0 ? 'complete' : 'send'
}

/**
 * One slash-menu row. Extracted so `useInteractiveState` runs per row
 * (hooks cannot run inside the parent's map). This menu's selection
 * convention is `accentLight` bg + `accent` text; hover shares the
 * accentLight fill, and pressed layers `surfacePressed` on top.
 */
function SlashCommandRow({ cmd, index, isSelected, onSelect }: {
  cmd: SlashCommand
  index: number
  isSelected: boolean
  onSelect: (cmd: SlashCommand) => void
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      data-cmd-idx={index}
      onClick={() => onSelect(cmd)}
      {...handlers}
      className="ion-focusable w-full flex items-center gap-2.5 px-3 py-1.5 text-left"
      style={{
        background: pressed
          ? colors.surfacePressed
          : (isSelected || hover) ? colors.accentLight : 'transparent',
        border: 'none',
        transition: `background ${transitions.base}`,
      }}
    >
      <span
        className="flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0"
        style={{
          background: isSelected ? colors.accentSoft : colors.surfaceHover,
          color: isSelected ? colors.accent : colors.textTertiary,
          transition: `background ${transitions.base}, color ${transitions.base}`,
        }}
      >
        {cmd.icon}
      </span>
      <div className="min-w-0 flex-1">
        <span
          className="text-[12px] font-mono font-medium"
          style={{ color: isSelected ? colors.accent : colors.textPrimary, transition: `color ${transitions.base}` }}
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
  )
}

export function slashMenuPlacement(anchorRect: DOMRect, viewport = zoomViewport()): React.CSSProperties {
  const anchor = zoomRect(anchorRect)
  return {
    bottom: viewport.height - anchor.top + 4,
    left: anchor.left + 12,
    right: viewport.width - anchor.right + 12,
  }
}

export function SlashCommandMenu({ filter, selectedIndex, onSelect, anchorRect, extraCommands = [] }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  // Edge-anchored: the menu grows UPWARD out of the input row (`bottom:` is
  // computed from the row's top), so it is the clamp's family rather than the
  // anchored positioner's. Without this a long command list on a short window
  // ran off the top edge.
  const rootRef = useRef<HTMLDivElement>(null)
  useViewportClamp(rootRef, true)
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
      ref={rootRef}
      data-ion-ui
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        ...slashMenuPlacement(anchorRect),
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
            <React.Fragment key={`${cmd.command}-${cmd.group || 'builtin'}`}>
              {showHeader && (
                <div
                  className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-wider font-medium"
                  style={{ color: colors.textTertiary }}
                >
                  {GROUP_LABELS[currentGroup] || currentGroup}
                </div>
              )}
              <SlashCommandRow cmd={cmd} index={i} isSelected={isSelected} onSelect={onSelect} />
            </React.Fragment>
          )
        })}
      </div>
    </motion.div>,
    popoverLayer,
  )
}
