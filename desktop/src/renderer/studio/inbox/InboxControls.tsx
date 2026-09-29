import React, { useEffect, useRef } from 'react'
import { Check, CaretDown, Desktop, Folder, SortAscending, Broadcast, Stack } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useColors } from '../../theme'
import { scrollableMenuStyle } from '../../menu-viewport'
import { toggleProjectSelection, type InboxProjectSelection } from './project-selection'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentViewFilter } from '@ion/shared/types-environments'
import { useEnvironmentAvailabilityMap } from '../connection/environment-availability'

export type InboxSortOrder = 'created' | 'activity' | 'title'

interface ProjectScopePickerProps {
  anchor: { x: number; y: number }
  projects: Array<{ key: string; name: string; count: number }>
  selected: InboxProjectSelection
  onSelect: (projects: InboxProjectSelection) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

interface InboxSortPickerProps {
  anchor: { x: number; y: number }
  selected: InboxSortOrder
  onSelect: (order: InboxSortOrder) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

function useDismiss(
  ref: React.RefObject<HTMLDivElement | null>,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current && !ref.current.contains(target) && !triggerRef.current?.contains(target)) onClose()
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
  }, [onClose, ref, triggerRef])
}

function PickerRoot({
  anchor,
  children,
  onClose,
  triggerRef,
  width = 260,
  deps = [],
}: {
  anchor: { x: number; y: number }
  children: React.ReactNode
  onClose: () => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  width?: number
  deps?: ReadonlyArray<unknown>
}): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const rootRef = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPopover(anchor, { deps })
  useDismiss(rootRef, triggerRef, onClose)
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
      aria-pressed={active}
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
  triggerRef,
  onClose,
}: ProjectScopePickerProps): React.JSX.Element | null {
  return (
    <PickerRoot anchor={anchor} triggerRef={triggerRef} onClose={onClose} deps={[projects.length, selected]}>
      <div style={{ padding: '3px 10px 5px', color: 'inherit', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.65 }}>
        PROJECT SCOPE
      </div>
      <PickerOption active={selected.size === 0} onClick={() => onSelect(new Set())}>
        <Folder size={15} />
        <span style={{ flex: 1 }}>All projects</span>
        <span style={{ opacity: 0.6 }}>{projects.reduce((sum, project) => sum + project.count, 0)}</span>
      </PickerOption>
      <div style={{ height: 1, margin: '4px 10px', background: 'currentColor', opacity: 0.12 }} />
      {projects.map((project) => (
        <PickerOption key={project.key} active={selected.has(project.key)} onClick={() => onSelect(toggleProjectSelection(selected, project.key))}>
          <Folder size={15} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
          <span style={{ opacity: 0.6 }}>{project.count}</span>
        </PickerOption>
      ))}
    </PickerRoot>
  )
}

/** Rich active-list sort picker. Snoozed and settled retain lifecycle ordering. */
export function InboxSortPicker({ anchor, selected, onSelect, triggerRef, onClose }: InboxSortPickerProps): React.JSX.Element | null {
  const options: Array<{ id: InboxSortOrder; label: string; detail: string }> = [
    { id: 'created', label: 'Newest created', detail: 'Stable inbox order' },
    { id: 'activity', label: 'Recent activity', detail: 'Latest work first' },
    { id: 'title', label: 'Title', detail: 'A to Z' },
  ]
  return (
    <PickerRoot anchor={anchor} triggerRef={triggerRef} onClose={onClose} width={240} deps={[selected]}>
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

interface InboxEnvironmentPickerProps {
  anchor: { x: number; y: number }
  /** Every catalogued Environment, local first, with how many of the Inbox's rows each one owns. */
  environments: Array<{ id: string; label: string; count: number }>
  selected: EnvironmentViewFilter
  onSelect: (filter: EnvironmentViewFilter) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

/**
 * Which Environments the Inbox lists (spec 13's `All | Local | <id>`).
 *
 * This is a VIEW filter and nothing else: every Environment stays connected
 * behind it, so narrowing the list never disconnects anything and widening
 * it never reconnects anything. It exists because the filter was reachable
 * only by side effect before -- completing a transfer pinned it to the
 * transfer's target, and with no control anywhere the Inbox stayed narrowed
 * with no way back.
 */
export function InboxEnvironmentPicker({ anchor, environments, selected, onSelect, triggerRef, onClose }: InboxEnvironmentPickerProps): React.JSX.Element | null {
  const availability = useEnvironmentAvailabilityMap()
  const total = environments.reduce((sum, environment) => sum + environment.count, 0)
  return (
    <PickerRoot anchor={anchor} triggerRef={triggerRef} onClose={onClose} width={250} deps={[environments.length, selected]}>
      <div style={{ padding: '3px 10px 5px', color: 'inherit', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', opacity: 0.65 }}>
        ENVIRONMENTS
      </div>
      <PickerOption active={selected === 'all'} onClick={() => { onSelect('all'); onClose() }}>
        <Stack size={15} />
        <span style={{ flex: 1 }}>All environments</span>
        <span style={{ opacity: 0.6 }}>{total}</span>
      </PickerOption>
      <div style={{ height: 1, margin: '4px 10px', background: 'currentColor', opacity: 0.12 }} />
      {environments.map((environment) => {
        const state = availability.get(environment.id)?.availability ?? 'connected'
        const local = environment.id === LOCAL_ENVIRONMENT_ID
        const filter: EnvironmentViewFilter = local ? 'local' : environment.id
        return (
          <PickerOption key={environment.id} active={selected === filter} onClick={() => { onSelect(filter); onClose() }}>
            {local ? <Desktop size={15} /> : <Broadcast size={15} />}
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ display: 'block' }}>{environment.label}</span>
              {state !== 'connected' && (
                <span style={{ display: 'block', marginTop: 1, fontSize: 10, opacity: 0.6 }}>
                  {state === 'reconnecting' ? 'reconnecting' : 'offline — nothing to list'}
                </span>
              )}
            </span>
            <span style={{ opacity: 0.6 }}>{environment.count}</span>
          </PickerOption>
        )
      })}
    </PickerRoot>
  )
}

/**
 * One filter control in the Inbox header.
 *
 * Icon-first, label only when it is carrying information. Three controls
 * sharing a sidebar this narrow cannot each afford a phrase: "All projects
 * / All environments / Recent activity" wrapped every button onto two lines
 * and ate the header. At rest the icon IS the label -- a folder, a
 * broadcast mast, a sort glyph -- and the hover text says the rest. A
 * control only spends horizontal space once it has been narrowed to
 * something, and even then the label is one line, truncated rather than
 * wrapped, so a long project name cannot crowd its neighbours out.
 */
export function InboxControlButton({
  icon,
  label,
  title,
  onClick,
  active = false,
  buttonRef,
}: {
  icon: React.ReactNode
  /** Shown only when it says something the icon does not: the filter is narrowed. Null keeps the control square. */
  label?: string | null
  /** Hover/assistive text, always present — it is the only label in the icon-only state. */
  title: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  active?: boolean
  buttonRef?: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const colors = useColors()
  const labelled = label != null && label !== ''
  return (
    <button
      ref={buttonRef}
      className="ion-focusable"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: labelled ? 150 : 28,
        width: labelled ? undefined : 28,
        height: 26,
        padding: labelled ? '0 7px' : 0,
        border: `1px solid ${active ? colors.accent : colors.containerBorder}`,
        borderRadius: 5,
        background: active ? colors.accentLight : 'transparent',
        color: active ? colors.textPrimary : colors.textSecondary,
        cursor: 'pointer',
        fontSize: 10,
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      {labelled && (
        <>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <CaretDown size={10} style={{ flexShrink: 0, opacity: 0.7 }} />
        </>
      )}
    </button>
  )
}
