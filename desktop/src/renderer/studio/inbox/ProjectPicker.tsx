/**
 * ProjectPicker — compose-flow project chooser (G2): registry entries
 * ordered by recency with ⌘1..9 quick-select, plus a native-browse escape
 * hatch. On pick, the caller routes into the existing conversation-create
 * path (createTabInDirectory — ONE forwarded action, mirror-safe).
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { FolderOpen } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { usePreferencesStore } from '../../preferences'
import { orderedProjects } from '../../../shared/project-registry'
import { rError } from '../../rendererLogger'
import { scrollableMenuStyle } from '../../menu-viewport'

function PickerRow({
  label,
  detail,
  shortcut,
  onSelect,
}: {
  label: string
  detail?: string
  shortcut?: string
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
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {detail && (
        <span style={{ color: colors.textTertiary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {detail}
        </span>
      )}
      {shortcut && <span style={{ marginLeft: 'auto', color: colors.textTertiary, fontSize: 10, flexShrink: 0 }}>{shortcut}</span>}
    </button>
  )
}

export function ProjectPicker({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number
  y: number
  /** The chosen project directory (registry entry or browsed). */
  onPick: (dir: string) => void
  onClose: () => void
}): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const registry = usePreferencesStore((s) => s.projects)
  const addProject = usePreferencesStore((s) => s.addProject)
  const projects = useMemo(() => orderedProjects(registry), [registry])

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // ⌘1..9 quick-select by recency order.
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        const target = projects[idx]
        if (target) {
          e.preventDefault()
          onPick(target.dir)
          onClose()
        }
      }
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose, onPick, projects])

  const browse = (): void => {
    void window.ion
      .selectDirectory()
      .then((dir) => {
        if (dir) {
          addProject(dir)
          onPick(dir)
        }
        onClose()
      })
      .catch((err) => {
        rError('project-picker', 'browse failed', { error: String(err) })
        onClose()
      })
  }

  const pos = useAnchoredPopover({ x, y }, { deps: [projects.length] })

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
        width: 280,
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
      {projects.map((p, i) => (
        <PickerRow
          key={p.dir}
          label={p.displayName}
          detail={p.dir}
          shortcut={i < 9 ? `⌘${i + 1}` : undefined}
          onSelect={() => {
            onPick(p.dir)
            onClose()
          }}
        />
      ))}
      {projects.length > 0 && <div style={{ height: 1, background: colors.containerBorder, margin: '4px 0' }} />}
      <button
        onClick={browse}
        className="ion-focusable"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '5px 12px',
          border: 'none',
          background: 'transparent',
          color: colors.accent,
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: 12,
        }}
      >
        <FolderOpen size={13} />
        Browse…
      </button>
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
