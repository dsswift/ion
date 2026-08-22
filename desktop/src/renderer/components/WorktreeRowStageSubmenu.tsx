/** Stage picker opened from the worktree context menu. */
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Check, XCircle } from '@phosphor-icons/react'
import { WORK_STAGES, type WorkStage } from '../../shared/types-git'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useColors } from '../theme'
import { scrollableMenuStyle } from '../menu-viewport'
import { ContextMenuItem } from './ContextMenuItem'
import { usePopoverLayer } from './PopoverLayer'
import { workStageColor, workStageIcon } from './WorktreeStageSlot'

interface WorktreeRowStageSubmenuProps {
  anchor: { x: number; y: number }
  activeStage?: WorkStage
  parentRect: { left: number; right: number; top: number; bottom: number }
  triggerRef: React.RefObject<HTMLElement | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  onClose(): void
  onSelect(stage: WorkStage | null): void
}

/** Lists workflow stages in canonical order and supports explicit clearing. */
export function WorktreeRowStageSubmenu({
  anchor,
  activeStage,
  parentRect,
  triggerRef,
  containerRef,
  onClose,
  onSelect,
}: WorktreeRowStageSubmenuProps): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPopover(anchor, {
    prefer: 'rightOf',
    parentRect,
    anchorSpace: 'css',
    deps: [activeStage],
  })

  useEffect(() => {
    const handlePointer = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target) || triggerRef.current?.contains(target)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose, triggerRef])

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={(node) => {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
        ;(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-ion-ui
      data-testid="worktree-row-stage-submenu"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10001,
        minWidth: 180,
        boxShadow: colors.popoverShadow,
      }}
    >
      <div className="px-2 py-1 text-[10px] font-medium" style={{ color: colors.textTertiary }}>
        Stage
      </div>
      {WORK_STAGES.map((stage) => {
        const active = stage.id === activeStage
        const color = active ? workStageColor(stage.id, colors) : colors.textSecondary
        return (
          <ContextMenuItem
            key={stage.id}
            onClick={() => onSelect(active ? null : stage.id)}
          >
            <span style={{ display: 'inline-flex', color }}>
              {workStageIcon(stage.id, 12, active)}
            </span>
            <span>{stage.label}</span>
            {active && (
              <Check
                data-testid="worktree-stage-active-check"
                size={12}
                color={color}
                style={{ marginLeft: 'auto' }}
              />
            )}
          </ContextMenuItem>
        )
      })}
      {activeStage && (
        <>
          <div
            data-testid="worktree-stage-submenu-separator"
            style={{ height: 1, background: colors.popoverBorder, margin: '2px 0' }}
          />
          <ContextMenuItem onClick={() => onSelect(null)}>
            <XCircle size={12} color={colors.textSecondary} />
            <span>Clear stage</span>
          </ContextMenuItem>
        </>
      )}
    </motion.div>,
    popoverLayer,
  )
}
