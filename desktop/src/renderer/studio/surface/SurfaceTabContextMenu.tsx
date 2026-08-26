/**
 * SurfaceTabContextMenu — right-click menu for a surface tab pill:
 * Link agent (browser) / Close / Close Others / Close to the Right /
 * Copy Path (file/preview).
 */
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useColors } from '../../theme'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { isPinnableSingleton, type SurfaceTab } from '../../../shared/studio-surface-types'
import { useSurfaceStore } from './surface-store'
import { scrollableMenuStyle } from '../../menu-viewport'

function MenuButton({
  label,
  disabled,
  onSelect,
}: {
  label: string
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className="ion-focusable"
      {...handlers}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '5px 12px',
        border: 'none',
        background: disabled ? 'transparent' : interactiveBg(colors, { hover, pressed }),
        color: colors.textPrimary,
        opacity: disabled ? 0.45 : undefined,
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        fontSize: 12,
        transition: `background ${transitions.base}`,
      }}
    >
      {label}
    </button>
  )
}

export function SurfaceTabContextMenu({
  x,
  y,
  tab,
  onClose,
}: {
  x: number
  y: number
  tab: SurfaceTab
  onClose: () => void
}): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose])

  const store = useSurfaceStore
  const exec = (fn: () => void): void => {
    fn()
    onClose()
  }
  const pinnable = isPinnableSingleton(tab)
  const pinned = pinnable && store.getState().pinnedTabs.includes(tab.id)
  const filePath = tab.kind === 'file' || tab.kind === 'preview' ? tab.filePath : null
  // The agent link is the operator's to move. Offered only on a browser tab
  // that is not already linked, so the menu never contains a no-op — and never
  // on a non-browser tab, which the agent's tools cannot drive at all.
  const conversationId = store.getState().currentConversationId
  const linkedInstanceId = conversationId
    ? (store.getState().conversations[conversationId]?.agentBrowserInstanceId ?? null)
    : null
  const canLinkAgent = tab.kind === 'browser' && tab.instanceId !== linkedInstanceId

  type Item = { label: string; action: () => void; disabled?: boolean } | 'separator'
  const items: Item[] = [
    ...(canLinkAgent && tab.kind === 'browser'
      ? ([
          { label: 'Link agent to this tab', action: () => exec(() => store.getState().linkAgentBrowser(tab.instanceId)) },
          'separator',
        ] as Item[])
      : []),
    ...(pinnable ? [{ label: pinned ? 'Unpin' : 'Pin', action: () => exec(() => pinned ? store.getState().unpinTab(tab.id) : store.getState().pinTab(tab.id)) }] as Item[] : []),
    { label: 'Close', action: () => exec(() => store.getState().closeTab(tab.id)) },
    { label: 'Close Others', action: () => exec(() => store.getState().closeOthers(tab.id)) },
    // Singletons are pinned: "to the right" only ever closes dynamics.
    { label: 'Close to the Right', action: () => exec(() => store.getState().closeToRight(tab.id)) },
    ...(filePath
      ? ([
          'separator',
          {
            label: 'Copy Path',
            action: () => exec(() => void navigator.clipboard.writeText(filePath)),
          },
        ] as Item[])
      : []),
  ]

  const pos = useAnchoredPopover({ x, y }, { deps: [items.length] })

  const menu = (
    <div
      ref={(node) => {
        ;(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-ion-ui
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width: 190,
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: '4px 0',
        zIndex: 99999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep-${i}`} style={{ height: 1, background: colors.containerBorder, margin: '4px 0' }} />
        ) : (
          <MenuButton key={item.label} label={item.label} disabled={item.disabled} onSelect={item.action} />
        ),
      )}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
