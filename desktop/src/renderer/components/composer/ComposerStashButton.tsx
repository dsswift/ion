/**
 * ComposerStashButton — shows how many prompts are set aside for this project
 * and opens the list to bring one back or discard it. Hidden when there are
 * none, so the control row stays quiet until the feature is in use.
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Archive, Paperclip, Trash } from '@phosphor-icons/react'
import type { ComposerStashEntry } from '@ion/shared/composer-stash'
import { useColors } from '../../theme'
import { usePopoverLayer } from '../PopoverLayer'
import { useViewportClamp } from '../../hooks/useViewportClamp'
import { zoomAnchorEdges } from '../../viewport-zoom'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { Tooltip } from '../git/Tooltip'

interface Props {
  entries: ComposerStashEntry[]
  onRestore: (entry: ComposerStashEntry) => void
  onRemove: (entry: ComposerStashEntry) => void
}

/** The first non-empty line, which is what a person recognises a prompt by. */
export function stashEntryTitle(entry: Pick<ComposerStashEntry, 'text' | 'attachments'>): string {
  const line = entry.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (line) return line
  return entry.attachments.length === 1 ? entry.attachments[0].name : `${entry.attachments.length} attachments`
}

function StashRow({ entry, onRestore, onRemove }: { entry: ComposerStashEntry; onRestore: () => void; onRemove: () => void }): React.JSX.Element {
  const colors = useColors()
  const row = useInteractiveState()
  const trash = useInteractiveState()
  return (
    <div className="flex items-center" data-testid="composer-stash-row" style={{ background: interactiveBg(colors, row) }}>
      <button
        type="button"
        {...row.handlers}
        onClick={onRestore}
        className="flex items-center gap-2 px-3 py-1.5 text-[12px] ion-focusable"
        style={{ flex: 1, minWidth: 0, textAlign: 'left', color: colors.textPrimary }}
      >
        <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{stashEntryTitle(entry)}</span>
        {entry.attachments.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px]" style={{ color: colors.textTertiary }}>
            <Paperclip size={10} />{entry.attachments.length}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label="Discard stashed prompt"
        {...trash.handlers}
        onClick={onRemove}
        className="flex items-center justify-center rounded-md ion-focusable"
        style={{ width: 24, height: 24, marginRight: 4, color: colors.dangerFg, background: interactiveBg(colors, trash) }}
      >
        <Trash size={12} />
      </button>
    </div>
  )
}

export function ComposerStashButton({ entries, onRestore, onRemove }: Props): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ bottom: 0, right: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const state = useInteractiveState()
  useViewportClamp(menuRef, open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // The last entry leaving closes the menu along with the button.
  useEffect(() => { if (entries.length === 0) setOpen(false) }, [entries.length])

  if (entries.length === 0) return null

  const toggle = (): void => {
    if (!open && triggerRef.current) {
      const rect = zoomAnchorEdges(triggerRef.current.getBoundingClientRect())
      setPos({ bottom: rect.fromBottom + 6, right: rect.fromRight })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <Tooltip text="Stashed prompts">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Stashed prompts"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="composer-stash-button"
          {...state.handlers}
          onClick={toggle}
          className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 ion-focusable"
          style={{ color: colors.textSecondary, background: interactiveBg(colors, { ...state, selected: open }) }}
        >
          <Archive size={11} />
          {entries.length}
        </button>
      </Tooltip>
      {open && popoverLayer && createPortal(
        <motion.div
          ref={menuRef}
          role="menu"
          data-ion-ui
          data-testid="composer-stash-menu"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl py-1 overflow-y-auto"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            right: pos.right,
            width: 320,
            maxHeight: 280,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          {entries.map((entry) => (
            <StashRow key={entry.id} entry={entry} onRestore={() => { onRestore(entry); setOpen(false) }} onRemove={() => onRemove(entry)} />
          ))}
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
