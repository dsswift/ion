import React, { useState } from 'react'
import { Folder, GitBranch, Plus, Desktop, CaretDown, CaretRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import type { EngineProfile } from '@ion/shared/types'
import type { MergedProjectRow } from '../studio/connection/environment-projects'
import type { ProjectGroup } from './new-conversation-project-order'
import { PickerMenu, PickerMenuOption } from './NewConversationPickerMenu'
import { actingHolder, isLocalEnvironment, machineControlFor } from './new-conversation-machine-control'

/**
 * Repository rows.
 *
 * Where a row opens is said in its second line, by colouring the machine
 * name: this machine in the accent, any other in `iconPurple`.
 * That is what keeps a remote row from reading like a local one while the
 * list stays quiet -- a tinted word rather than a badge per row. The colour
 * is dropped inside a per-machine section, where the heading already names
 * the machine for every row under it.
 *
 * The right-hand side is only ever the offer: the other machines this project
 * could open on, which most projects do not have. See
 * `new-conversation-machine-control.ts` for the split.
 *
 * Sections come from `groupProjectRows`; a labelled one is collapsible, and
 * the single unlabelled section is the whole list. Row position for the
 * keyboard comes from `indexOf` rather than a second walk over the sections,
 * so the drawn order and the walked order cannot drift.
 */
export function ProjectRows({ groups, collapsed, indexOf, highlighted, colors, showMachines, actingEnvironment, onHover, onChoose, onToggleGroup }: {
  groups: readonly ProjectGroup[]
  collapsed: ReadonlySet<string>
  indexOf(groupKey: string, rowKey: string): number
  highlighted: number
  colors: ReturnType<typeof useColors>
  /** False when only one machine is connected: there is no machine to name and none to offer. */
  showMachines: boolean
  actingEnvironment(row: MergedProjectRow, groupEnvironmentId: string | null): string
  onHover(index: number): void
  onChoose(row: MergedProjectRow, environmentId?: string): void
  onToggleGroup(groupKey: string): void
}): React.JSX.Element {
  // One menu at a time, held here because a row cannot own state inside a map.
  const [machineMenu, setMachineMenu] = useState<{ rowKey: string; groupKey: string; anchor: { x: number; y: number }; trigger: HTMLElement } | null>(null)
  if (groups.length === 0) return <PickerMessage colors={colors} message="No loaded projects match this search." />
  return <>{groups.map((group) => {
    const isCollapsed = group.label !== null && collapsed.has(group.key)
    const header = group.label === null
      ? <PickerSection colors={colors} label="Projects" />
      : <PickerGroupHeader colors={colors} label={group.label} count={group.rows.length} collapsed={isCollapsed} onToggle={() => onToggleGroup(group.key)} />
    const inMachineSection = group.environmentId !== null
    return <React.Fragment key={group.key}>
      {header}
      {!isCollapsed && group.rows.map((row) => {
        const index = indexOf(group.key, row.key)
        const acting = actingEnvironment(row, group.environmentId)
        const holder = actingHolder(row, acting)
        const path = holder ? (holder.entry.managed ? `Managed · ${holder.entry.dir}` : holder.entry.dir) : row.dir
        const namesMachine = showMachines && !inMachineSection && !!holder
        const detail = namesMachine && holder
          ? <><span style={{ color: isLocalEnvironment(holder.environmentId) ? colors.accent : colors.iconPurple }}>{holder.label}</span>{` · ${path}`}</>
          : path
        const control = showMachines ? machineControlFor(row, acting, { inMachineSection }) : { kind: 'none' as const }
        const open = machineMenu?.rowKey === row.key && machineMenu.groupKey === group.key
        const openMenu = (event: React.MouseEvent<HTMLSpanElement>): void => {
          if (open) { setMachineMenu(null); return }
          const rect = event.currentTarget.getBoundingClientRect()
          setMachineMenu({ rowKey: row.key, groupKey: group.key, anchor: { x: rect.left, y: rect.bottom }, trigger: event.currentTarget })
        }
        return <React.Fragment key={`${group.key}:${row.key}`}>
          <PickerRow
            active={index === highlighted}
            colors={colors}
            icon={<Folder size={16} />}
            title={row.displayName}
            detail={detail}
            trailing={control.kind === 'none' ? undefined : control.kind === 'alternative'
              ? <MachineChip colors={colors} label={control.holder.label} ariaLabel={`Open it on ${control.holder.label}`} onClick={() => onChoose(row, control.holder.environmentId)} />
              : <MachineChip colors={colors} label={`+${control.alternatives.length}`} caret ariaLabel={`Open it on another machine (${control.alternatives.length} others)`} onClick={openMenu} />}
            onMouseEnter={() => onHover(index)}
            onClick={() => onChoose(row, acting)}
          />
          {open && control.kind === 'alternatives' && <PickerMenu anchor={machineMenu.anchor} ariaLabel={`Open ${row.displayName} on another machine`} heading="OPEN IT ON" triggerEl={machineMenu.trigger} width={240} deps={[control.alternatives.length]} onClose={() => setMachineMenu(null)}>
            {control.alternatives.map((alternative) => (
              <PickerMenuOption
                key={alternative.environmentId}
                label={alternative.label}
                detail={alternative.entry.dir}
                icon={<Desktop size={13} />}
                onClick={() => { setMachineMenu(null); onChoose(row, alternative.environmentId) }}
              />
            ))}
          </PickerMenu>}
        </React.Fragment>
      })}
    </React.Fragment>
  })}</>
}

/**
 * One offered machine, or the count of them. Muted at rest, because it is an
 * option rather than a statement about where the row goes -- that is the
 * second line's job -- and it brightens under the pointer so it reads as
 * clickable rather than as a label.
 *
 * A span with a button role, because the row itself is a button and buttons
 * do not nest; the pointer handlers still bubble, so hovering the chip keeps
 * highlighting the row under it.
 */
function MachineChip({ colors, label, caret, ariaLabel, onClick }: {
  colors: ReturnType<typeof useColors>
  label: string
  caret?: boolean
  ariaLabel: string
  onClick(event: React.MouseEvent<HTMLSpanElement>): void
}): React.JSX.Element {
  const { hover, pressed, handlers } = useInteractiveState()
  return <span
    role="button"
    tabIndex={-1}
    aria-label={ariaLabel}
    {...handlers}
    onClick={(event) => { event.stopPropagation(); onClick(event) }}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10,
      padding: '1px 6px', borderRadius: 999,
      border: `1px solid ${hover || pressed ? colors.accentBorderMedium : colors.containerBorder}`,
      color: hover || pressed ? colors.textPrimary : colors.textTertiary,
      background: interactiveBg(colors, { hover, pressed }),
      cursor: 'pointer', whiteSpace: 'nowrap',
      transition: `background ${transitions.fast}, color ${transitions.fast}, border-color ${transitions.fast}`,
    }}
  >
    <Desktop size={11} />{label}{caret && <CaretDown size={9} />}
  </span>
}

/** A collapsible machine section header. */
export function PickerGroupHeader({ colors, label, count, collapsed, onToggle }: { colors: ReturnType<typeof useColors>; label: string; count: number; collapsed: boolean; onToggle(): void }): React.JSX.Element {
  return <button className="ion-focusable" aria-expanded={!collapsed} onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 10px 6px', border: 'none', background: 'transparent', color: colors.textTertiary, fontSize: 11, fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}>
    {collapsed ? <CaretRight size={11} weight="bold" /> : <CaretDown size={11} weight="bold" />}
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    <span style={{ opacity: 0.7, fontWeight: 500 }}>{count}</span>
  </button>
}

/** The way out of the list for a project that does not exist yet: create its repository and clone it. */
export function NewProjectRow({ colors, onClick }: { colors: ReturnType<typeof useColors>; onClick(): void }): React.JSX.Element {
  return <PickerRow active={false} colors={colors} icon={<Plus size={16} />} title="New project…" detail="Create a repository and clone it onto your servers" onMouseEnter={() => {}} onClick={onClick} />
}

export function BranchRows({ branches, highlighted, loading, error, currentBranch, colors, onHover, onChoose }: { branches: readonly string[]; highlighted: number; loading: boolean; error: string | null; currentBranch: string; colors: ReturnType<typeof useColors>; onHover(index: number): void; onChoose(branch: string): void }): React.JSX.Element {
  if (loading) return <PickerMessage colors={colors} message="Loading branches…" />
  if (error) return <PickerMessage colors={colors} message={`Could not load branches: ${error}`} />
  if (branches.length === 0) return <PickerMessage colors={colors} message="No branches match this search." />
  return <><PickerSection colors={colors} label="Choose source branch" />{branches.map((branch, index) => <PickerRow key={branch} active={highlighted === index} colors={colors} icon={<GitBranch size={16} />} title={branch} detail={branch === currentBranch ? 'Current branch' : undefined} onMouseEnter={() => onHover(index)} onClick={() => onChoose(branch)} />)}</>
}

export function ProfileRows({ profiles, highlighted, colors, onHover, onPlain, onProfile }: { profiles: EngineProfile[]; highlighted: number; colors: ReturnType<typeof useColors>; onHover(index: number): void; onPlain(): void; onProfile(profileId: string): void }): React.JSX.Element {
  return <><PickerSection colors={colors} label="Choose conversation type" /><PickerRow active={highlighted === 0} colors={colors} icon={<Folder size={16} />} title="Plain conversation" detail="No extensions" onMouseEnter={() => onHover(0)} onClick={onPlain} />{profiles.map((profile, index) => <PickerRow key={profile.id} active={highlighted === index + 1} colors={colors} icon={<Folder size={16} />} title={profile.name} detail={profile.extensions.map((extension) => extension.split('/').slice(-2).join('/')).join(', ')} onMouseEnter={() => onHover(index + 1)} onClick={() => onProfile(profile.id)} />)}{profiles.length === 0 && <PickerMessage colors={colors} message="No conversation profiles match this search." />}</>
}

export function PickerRow({ active, colors, icon, title, detail, trailing, onMouseEnter, onClick }: { active: boolean; colors: ReturnType<typeof useColors>; icon: React.ReactNode; title: string; detail?: React.ReactNode; trailing?: React.ReactNode; onMouseEnter(): void; onClick(): void }): React.JSX.Element {
  return <button className="ion-focusable" onMouseEnter={onMouseEnter} onClick={onClick} style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 10, padding: '8px 10px', border: 'none', borderRadius: 6, background: active ? colors.tabActive : 'transparent', color: colors.textPrimary, cursor: 'pointer', textAlign: 'left' }}><span style={{ color: colors.textTertiary, display: 'flex' }}>{icon}</span><span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>{detail && <span style={{ display: 'block', color: colors.textTertiary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>}</span>{trailing && <span style={{ flexShrink: 0 }}>{trailing}</span>}</button>
}

export function PickerSection({ colors, label }: { colors: ReturnType<typeof useColors>; label: string }): React.JSX.Element { return <div style={{ padding: '4px 10px 6px', color: colors.textTertiary, fontSize: 11, fontWeight: 600 }}>{label}</div> }
export function PickerMessage({ colors, message }: { colors: ReturnType<typeof useColors>; message: string }): React.JSX.Element { return <div style={{ padding: '14px 10px', color: colors.textTertiary, fontSize: 12 }}>{message}</div> }
