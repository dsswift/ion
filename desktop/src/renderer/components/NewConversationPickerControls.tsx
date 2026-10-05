import React, { useRef, useState } from 'react'
import { CaretDown, Compass, SortAscending, Stack } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { PickerMenu, PickerMenuOption } from './NewConversationPickerMenu'
import type { ProjectGrouping, ProjectSortOrder } from './new-conversation-project-order'
import { LOCAL_ENVIRONMENT_LABEL } from '../studio/connection/local-label'
import type { PlacementMode } from '../studio/connection/placement'

/**
 * The project list's sort and grouping controls.
 *
 * Both are per-device view preferences, so they persist in localStorage
 * exactly as the Inbox's own sort does, and never sync. The grouping control
 * is hidden outright when only one machine is connected: every mode collapses
 * to the same single list there, so offering three of them would be three
 * ways to change nothing.
 */

const SORT_LABELS: Record<ProjectSortOrder, string> = {
  'most-used': 'Most used',
  alphabetical: 'A to Z',
}

const GROUPING_LABELS: Record<ProjectGrouping, string> = {
  'local-first': `${LOCAL_ENVIRONMENT_LABEL} first`,
  'by-host': 'By machine',
  none: 'No grouping',
}

const SORT_OPTIONS: Array<{ id: ProjectSortOrder; label: string; detail: string }> = [
  { id: 'most-used', label: SORT_LABELS['most-used'], detail: 'How often you open work here' },
  { id: 'alphabetical', label: SORT_LABELS.alphabetical, detail: 'By project name' },
]

const GROUPING_OPTIONS: Array<{ id: ProjectGrouping; label: string; detail: string }> = [
  { id: 'local-first', label: GROUPING_LABELS['local-first'], detail: 'This machine, then the rest' },
  { id: 'by-host', label: GROUPING_LABELS['by-host'], detail: 'A collapsible section per machine' },
  { id: 'none', label: GROUPING_LABELS.none, detail: 'One flat list' },
]

const PLACEMENT_LABELS: Record<PlacementMode, string> = {
  manual: `${LOCAL_ENVIRONMENT_LABEL} by default`,
  auto: 'Auto machine',
}

const PLACEMENT_OPTIONS: Array<{ id: PlacementMode; label: string; detail: string }> = [
  { id: 'manual', label: PLACEMENT_LABELS.manual, detail: 'This machine when it has the project' },
  { id: 'auto', label: PLACEMENT_LABELS.auto, detail: 'The machine whose account has the most room' },
]

export function sortOrderLabel(order: ProjectSortOrder): string { return SORT_LABELS[order] }
export function groupingLabel(grouping: ProjectGrouping): string { return GROUPING_LABELS[grouping] }

interface MenuOption<T extends string> { id: T; label: string; detail: string }

function OptionMenu<T extends string>({ anchor, heading, options, selected, triggerEl, onSelect, onClose }: {
  anchor: { x: number; y: number }
  heading: string
  options: ReadonlyArray<MenuOption<T>>
  selected: T
  triggerEl: HTMLElement | null
  onSelect(value: T): void
  onClose(): void
}): React.JSX.Element | null {
  return (
    <PickerMenu anchor={anchor} ariaLabel={heading} heading={heading} triggerEl={triggerEl} onClose={onClose} deps={[selected, options.length]}>
      {options.map((option) => (
        <PickerMenuOption
          key={option.id}
          selected={option.id === selected}
          label={option.label}
          detail={option.detail}
          onClick={() => { onSelect(option.id); onClose() }}
        />
      ))}
    </PickerMenu>
  )
}

/** Brightens under the pointer, and stays lit while its menu is open. */
function ControlButton({ label, icon, buttonRef, open, onClick }: {
  label: string
  icon: React.ReactNode
  buttonRef: React.RefObject<HTMLButtonElement | null>
  open: boolean
  onClick(event: React.MouseEvent<HTMLButtonElement>): void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const lit = hover || pressed || open
  return (
    <button
      ref={buttonRef}
      className="ion-focusable"
      aria-haspopup="menu"
      aria-expanded={open}
      {...handlers}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 7px', borderRadius: 999,
        border: `1px solid ${lit ? colors.accentBorderMedium : colors.containerBorder}`,
        background: interactiveBg(colors, { hover, pressed, selected: open }),
        color: lit ? colors.textPrimary : colors.textSecondary,
        cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
        transition: `background ${transitions.fast}, color ${transitions.fast}, border-color ${transitions.fast}`,
      }}
    >
      {icon}{label}<CaretDown size={10} />
    </button>
  )
}

/** The bar under the search field: how the project list is ordered, and how it is divided. */
export function ProjectListControls({ sort, grouping, showGrouping, placement, onSort, onGrouping, onPlacement }: {
  sort: ProjectSortOrder
  grouping: ProjectGrouping
  /** True when more than one machine is connected; the machine controls only mean something then. */
  showGrouping: boolean
  placement: PlacementMode
  onSort(order: ProjectSortOrder): void
  onGrouping(grouping: ProjectGrouping): void
  onPlacement(mode: PlacementMode): void
}): React.JSX.Element {
  const placementButton = useRef<HTMLButtonElement>(null)
  const [placementAnchor, setPlacementAnchor] = useState<{ x: number; y: number } | null>(null)
  const colors = useColors()
  const sortButton = useRef<HTMLButtonElement>(null)
  const groupButton = useRef<HTMLButtonElement>(null)
  const [sortAnchor, setSortAnchor] = useState<{ x: number; y: number } | null>(null)
  const [groupAnchor, setGroupAnchor] = useState<{ x: number; y: number } | null>(null)
  const anchorFor = (event: React.MouseEvent<HTMLButtonElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: `1px solid ${colors.popoverBorder}` }}>
      <ControlButton label={SORT_LABELS[sort]} icon={<SortAscending size={12} />} buttonRef={sortButton} open={sortAnchor !== null} onClick={(event) => setSortAnchor(sortAnchor ? null : anchorFor(event))} />
      {showGrouping && <ControlButton label={GROUPING_LABELS[grouping]} icon={<Stack size={12} />} buttonRef={groupButton} open={groupAnchor !== null} onClick={(event) => setGroupAnchor(groupAnchor ? null : anchorFor(event))} />}
      {showGrouping && <ControlButton label={PLACEMENT_LABELS[placement]} icon={<Compass size={12} />} buttonRef={placementButton} open={placementAnchor !== null} onClick={(event) => setPlacementAnchor(placementAnchor ? null : anchorFor(event))} />}
      {placementAnchor && <OptionMenu anchor={placementAnchor} heading="DEFAULT MACHINE" options={PLACEMENT_OPTIONS} selected={placement} triggerEl={placementButton.current} onSelect={onPlacement} onClose={() => setPlacementAnchor(null)} />}
      {sortAnchor && <OptionMenu anchor={sortAnchor} heading="SORT PROJECTS" options={SORT_OPTIONS} selected={sort} triggerEl={sortButton.current} onSelect={onSort} onClose={() => setSortAnchor(null)} />}
      {groupAnchor && <OptionMenu anchor={groupAnchor} heading="GROUP PROJECTS" options={GROUPING_OPTIONS} selected={grouping} triggerEl={groupButton.current} onSelect={onGrouping} onClose={() => setGroupAnchor(null)} />}
    </div>
  )
}
