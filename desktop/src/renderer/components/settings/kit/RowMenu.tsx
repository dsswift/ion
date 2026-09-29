/**
 * RowMenu — the `…` button at the end of a list row. Holds the actions a
 * row needs rarely (trust, move, revoke, remove), so the row itself stays
 * one line. Opens in the popover layer so a scrolling list cannot clip it.
 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DotsThree, type Icon } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { usePopoverLayer } from '../../PopoverLayer'
import { ContextMenuItem } from '../../ContextMenuItem'
import { useAnchoredPopover } from '../../../hooks/useAnchoredPopover'
import { IconButton } from './controls'
import { useEscapeLayer } from './escape-stack'

export interface RowMenuItem {
  label: string
  icon?: Icon
  onSelect(): void
  danger?: boolean
  disabled?: boolean
  /** Why a disabled item is disabled. */
  title?: string
}

export function RowMenu({ items, label = 'More actions' }: { items: ReadonlyArray<RowMenuItem | false | null | undefined>; label?: string }): React.JSX.Element | null {
  const shown = items.filter((i): i is RowMenuItem => !!i)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  if (shown.length === 0) return null
  return (
    <>
      <IconButton
        icon={DotsThree}
        label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor(anchor ? null : { x: r.right - 180, y: r.bottom - 4 })
        }}
      />
      {anchor && <RowMenuPopover anchor={anchor} items={shown} onClose={() => setAnchor(null)} />}
    </>
  )
}

function RowMenuPopover({ anchor, items, onClose }: { anchor: { x: number; y: number }; items: RowMenuItem[]; onClose(): void }): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const pos = useAnchoredPopover(anchor)
  const root = useRef<HTMLDivElement | null>(null)
  useEscapeLayer(true, onClose)
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose])
  if (!layer) return null
  return createPortal(
    <div
      ref={(el) => { root.current = el; pos.ref(el) }}
      role="menu"
      data-ion-ui
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, minWidth: 180, zIndex: 10050, padding: 4, pointerEvents: 'auto',
        visibility: pos.ready ? 'visible' : 'hidden', borderRadius: 8,
        background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`, boxShadow: colors.popoverShadow,
      }}
    >
      {items.map((item) => {
        const IconComp = item.icon
        return (
          <ContextMenuItem
            key={item.label}
            disabled={item.disabled}
            title={item.title}
            color={item.danger ? colors.dangerFg : undefined}
            onClick={() => { onClose(); item.onSelect() }}
          >
            {IconComp && <IconComp size={13} />}
            {item.label}
          </ContextMenuItem>
        )
      })}
    </div>,
    layer,
  )
}
