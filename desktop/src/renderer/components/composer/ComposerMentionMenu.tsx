/**
 * ComposerMentionMenu — the list of project files offered while an `@file`
 * mention is being typed. Edge-anchored above the composer like the slash
 * menu, and clamped to the window.
 */
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { File as FileIcon } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../PopoverLayer'
import { useViewportClamp } from '../../hooks/useViewportClamp'
import { interactiveBg } from '../../hooks/useInteractiveState'
import { slashMenuPlacement } from '../SlashCommandMenu'

interface Props {
  results: string[]
  selectedIndex: number
  anchorRect: DOMRect | null
  onPick: (path: string) => void
}

function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

export function ComposerMentionMenu({ results, selectedIndex, anchorRect, onPick }: Props): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useViewportClamp(rootRef, true)

  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-mention-idx="${selectedIndex}"]`) as HTMLElement | null
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  if (results.length === 0 || !anchorRect || !popoverLayer) return null

  return createPortal(
    <motion.div
      ref={rootRef}
      data-ion-ui
      data-testid="composer-mention-menu"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      style={{ position: 'fixed', ...slashMenuPlacement(anchorRect), pointerEvents: 'auto' }}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label="Project files"
        className="overflow-y-auto rounded-xl py-1"
        style={{
          maxHeight: 280,
          background: colors.popoverBg,
          backdropFilter: 'blur(20px)',
          border: `1px solid ${colors.popoverBorder}`,
          boxShadow: colors.popoverShadow,
        }}
      >
        {results.map((path, i) => {
          const { name, dir } = splitPath(path)
          const selected = i === selectedIndex
          return (
            <button
              key={path}
              type="button"
              role="option"
              aria-selected={selected}
              data-mention-idx={i}
              // Keep the editor focused; a click must not blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(path)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px]"
              style={{ textAlign: 'left', color: colors.textPrimary, background: interactiveBg(colors, { hover: false, pressed: false, selected }) }}
            >
              <FileIcon size={13} style={{ color: colors.textTertiary, flexShrink: 0 }} />
              <span style={{ flexShrink: 0 }}>{name}</span>
              <span className="truncate text-[11px]" style={{ color: colors.textTertiary, minWidth: 0 }}>{dir}</span>
            </button>
          )
        })}
      </div>
    </motion.div>,
    popoverLayer,
  )
}
