/**
 * SurfaceAddMenu — the “+” menu adding tabs to the Studio surface pane.
 *
 * Entries are data (SURFACE_ADD_ENTRIES): a future tab kind is one entry.
 * Portals into the PopoverLayer; pointerEvents:'auto' on the root (the
 * layer itself is pointer-transparent).
 */
import React, { useEffect, useRef } from 'react'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { createPortal } from 'react-dom'
import { ChartBar, FileText, FolderOpen, GitBranch, GitDiff, Globe, TerminalWindow } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { useSessionStore } from '../../stores/sessionStore'
import { useSurfaceStore, type SurfaceState } from './surface-store'
import { scrollableMenuStyle } from '../../menu-viewport'

interface AddEntry {
  id: string
  label: string
  icon: React.ComponentType<{ size?: number }>
  create: (store: SurfaceState, activeCwd: string) => void
}

/** Future surface kinds are one entry here. */
export const SURFACE_ADD_ENTRIES: readonly AddEntry[] = [
  { id: 'diff', label: 'Diff', icon: GitDiff, create: (s) => s.openSingleton('diff') },
  { id: 'plan', label: 'Plan Preview', icon: FileText, create: (s) => s.openSingleton('plan') },
  { id: 'visualizer', label: 'Visualizer', icon: ChartBar, create: (s) => s.openSingleton('visualizer') },
  { id: 'files', label: 'Explorer', icon: FolderOpen, create: (s) => s.openSingleton('files') },
  { id: 'gitpanel', label: 'Git', icon: GitBranch, create: (s) => s.openSingleton('gitpanel') },
  { id: 'browser', label: 'Browser', icon: Globe, create: (s) => s.openBrowserTab('', 'browse') },
  { id: 'terminal', label: 'Terminal', icon: TerminalWindow, create: (s, cwd) => s.openTerminalTab(cwd) },
]

function MenuButton({
  label,
  icon: Icon,
  onSelect,
}: {
  label: string
  icon: React.ComponentType<{ size?: number }>
  onSelect: () => void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onSelect}
      className="ion-focusable"
      {...handlers}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '5px 12px',
        border: 'none',
        background: interactiveBg(colors, { hover, pressed }),
        color: colors.textPrimary,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12,
        transition: `background ${transitions.base}`,
      }}
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

export function SurfaceAddMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const activeCwd = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory ?? '~')

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

  const pos = useAnchoredPopover({ x, y }, { deps: [SURFACE_ADD_ENTRIES.length] })

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
        width: 180,
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
      {SURFACE_ADD_ENTRIES.map((entry) => (
        <MenuButton
          key={entry.id}
          label={entry.label}
          icon={entry.icon}
          onSelect={() => {
            entry.create(useSurfaceStore.getState(), activeCwd)
            onClose()
          }}
        />
      ))}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
