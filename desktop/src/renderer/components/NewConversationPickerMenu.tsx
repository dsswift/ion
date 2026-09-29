import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { scrollableMenuStyle } from '../menu-viewport'

/**
 * The one popup the new-conversation picker opens: the sort and grouping
 * controls above the list, and a row's "open it somewhere else" menu. They
 * are the same object — an anchored, dismissable list of choices — so they
 * share a positioner and a dismiss rule rather than growing two of each.
 *
 * Escape is swallowed here. The picker's own Escape handler closes the whole
 * dialog, and a menu that dismissed the dialog behind it would lose the
 * operator's place.
 */
export function PickerMenu({ anchor, ariaLabel, heading, triggerEl, width = 250, deps = [], onClose, children }: {
  anchor: { x: number; y: number }
  ariaLabel: string
  heading: string
  /** The control that opened the menu; clicking it again closes rather than reopens. */
  triggerEl: HTMLElement | null
  width?: number
  deps?: ReadonlyArray<unknown>
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const rootRef = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPopover(anchor, { deps })
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || triggerEl?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose, triggerEl])

  const menu = (
    <div
      ref={(node) => { rootRef.current = node; pos.ref(node) }}
      data-ion-ui
      role="menu"
      aria-label={ariaLabel}
      style={{
        position: 'fixed', left: pos.left, top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width, padding: '5px 0',
        background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8, boxShadow: colors.popoverShadow, color: colors.textPrimary,
        pointerEvents: 'auto', zIndex: 99999,
      }}
    >
      <div style={{ padding: '3px 10px 5px', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.65 }}>{heading}</div>
      {children}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}

/**
 * One choice in a `PickerMenu`. `selected` renders the tick column and makes
 * it a radio — omit it for a menu whose entries are actions rather than a
 * setting, so an action never renders an empty tick gutter.
 *
 * The pointer layer sits above the selected tint rather than replacing it, so
 * hovering the option you are already on still responds.
 */
export function PickerMenuOption({ selected, label, detail, icon, onClick }: {
  selected?: boolean
  label: string
  detail?: string
  icon?: React.ReactNode
  onClick(): void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const isRadio = selected !== undefined
  return (
    <button
      className="ion-focusable"
      role={isRadio ? 'menuitemradio' : 'menuitem'}
      {...(isRadio ? { 'aria-checked': selected } : {})}
      {...handlers}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 32,
        padding: '5px 10px', border: 'none',
        background: interactiveBg(colors, { hover, pressed }, selected ? colors.accentLight : 'transparent'),
        color: colors.textPrimary, cursor: 'pointer', fontSize: 12, textAlign: 'left',
        transition: `background ${transitions.fast}`,
      }}
    >
      {isRadio && (
        <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', color: colors.accent }}>
          {selected ? <Check size={13} weight="bold" /> : null}
        </span>
      )}
      {icon && <span style={{ display: 'inline-flex', color: colors.textTertiary }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {detail && <span style={{ display: 'block', marginTop: 1, fontSize: 10, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>}
      </span>
    </button>
  )
}
