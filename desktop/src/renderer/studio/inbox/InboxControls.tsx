import React, { useEffect, useRef } from 'react'
import { Check, CaretDown, Folder, SortAscending } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useColors } from '../../theme'
import { scrollableMenuStyle } from '../../menu-viewport'

export type InboxSortOrder = 'created' | 'activity' | 'title'

interface ProjectScopePickerProps {
  anchor: { x: number; y: number }
  projects: Array<{ key: string; name: string; count: number }>
  selected: string | null
  onSelect: (project: string | null) => void
  onClose: () => void
}

interface InboxSortPickerProps {
  anchor: { x: number; y: number }
  selected: InboxSortOrder
  onSelect: (order: InboxSortOrder) => void
  onClose: () => void
}

function useDismiss(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose, ref])
}

function PickerRoot({
  anchor,
  children,
  onClose,
  width = 260,
  deps = [],
}: {
  anchor: { x: number; y: number }
  children: React.ReactNode
  onClose: () => void
  width?: number
  deps?: ReadonlyArray<unknown>
}): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const rootRef = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPopover(anchor, { deps })
  useDismiss(rootRef, onClose)
  const menu = (
    <div
      ref={(node) => {
        rootRef.current = node
        pos.ref(node)
      }}
      data-ion-ui
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width,
        padding: '5px 0',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        color: colors.textPrimary,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        zIndex: 99999,
      }}
    >
      {children}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}

function PickerOption({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  const colors = useColors()
  return (
    <button
      className="ion-focusable"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minHeight: 32,
        padding: '5px 10px',
        border: 'none',
        background: active ? colors.accentLight : 'transparent',
        color: colors.textPrimary,
        cursor: 'pointer',
        fontSize: 12,
        textAlign: 'left',
      }}
    >
      <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', color: colors.accent }}>
        {active ? <Check size={13} weight="bold" /> : null}
      </span>
      {children}
    </button>
  )
}

/** Rich project-scope picker. It replaces the native select in the inbox header. */
export function InboxProjectScopePicker({
  anchor,
  projects,
  selected,
  onSelect,
  onClose,
}: ProjectScopePickerProps): React.JSX.Element | null {
  return (
    <PickerRoot anchor={anchor} onClose={onClose} deps={[projects.length, selected]}>
      <div style={{ padding: '3px 10px 5px', color: 'inherit', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.65 }}>
        PROJECT SCOPE
      </div>
      <PickerOption active={selected === null} onClick={() => { onSelect(null); onClose() }}>
        <Folder size={15} />
        <span style={{ flex: 1 }}>All projects</span>
        <span style={{ opacity: 0.6 }}>{projects.reduce((sum, project) => sum + project.count, 0)}</span>
      </PickerOption>
      <div style={{ height: 1, margin: '4px 10px', background: 'currentColor', opacity: 0.12 }} />
      {projects.map((project) => (
        <PickerOption key={project.key} active={selected === project.key} onClick={() => { onSelect(project.key); onClose() }}>
          <Folder size={15} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
          <span style={{ opacity: 0.6 }}>{project.count}</span>
        </PickerOption>
      ))}
    </PickerRoot>
  )
}

/** Rich active-list sort picker. Snoozed and settled retain lifecycle ordering. */
export function InboxSortPicker({ anchor, selected, onSelect, onClose }: InboxSortPickerProps): React.JSX.Element | null {
  const options: Array<{ id: InboxSortOrder; label: string; detail: string }> = [
    { id: 'created', label: 'Newest created', detail: 'Stable inbox order' },
    { id: 'activity', label: 'Recent activity', detail: 'Latest work first' },
    { id: 'title', label: 'Title', detail: 'A to Z' },
  ]
  return (
    <PickerRoot anchor={anchor} onClose={onClose} width={240} deps={[selected]}>
      <div style={{ padding: '3px 10px 5px', color: 'inherit', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.65 }}>
        SORT ACTIVE CONVERSATIONS
      </div>
      {options.map((option) => (
        <PickerOption key={option.id} active={selected === option.id} onClick={() => { onSelect(option.id); onClose() }}>
          <SortAscending size={15} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block' }}>{option.label}</span>
            <span style={{ display: 'block', marginTop: 1, fontSize: 10, opacity: 0.6 }}>{option.detail}</span>
          </span>
        </PickerOption>
      ))}
    </PickerRoot>
  )
}

export function InboxControlButton({
  children,
  onClick,
  active = false,
  buttonRef,
}: {
  children: React.ReactNode
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  active?: boolean
  buttonRef?: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const colors = useColors()
  return (
    <button
      ref={buttonRef}
      className="ion-focusable"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
        maxWidth: 180,
        height: 26,
        padding: '0 8px',
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 5,
        background: active ? colors.surfacePrimary : 'transparent',
        color: colors.textSecondary,
        cursor: 'pointer',
        fontSize: 10,
      }}
    >
      {children}
      <CaretDown size={11} style={{ flexShrink: 0 }} />
    </button>
  )
}
