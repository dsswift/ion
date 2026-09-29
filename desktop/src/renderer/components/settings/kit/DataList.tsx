/**
 * DataList — every list in Settings. One line per item, a toolbar with a
 * count, a filter, and the list's actions, and a fixed height past which it
 * scrolls inside itself. A long list draws only the rows on screen, so two
 * hundred projects cost what twenty do.
 *
 * A row is one line on purpose. What an item needs rarely goes in its `…`
 * menu; what it needs to be edited goes in a side panel opened by a click.
 */
import React, { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { useInteractiveState } from '../../../hooks/useInteractiveState'
import { transitions } from '../../../theme-tokens'
import { GroupHeader } from './form'
import { RowMenu, type RowMenuItem } from './RowMenu'
import { EmptyState } from './status'
import { Tooltip } from '../../git/Tooltip'
import { KIT } from './tokens'

export interface DataColumn<T> {
  id: string
  header?: string
  /** A CSS grid track. The first column defaults to `minmax(0, 1fr)`, the rest to `auto`. */
  width?: string
  align?: 'start' | 'end'
  render(item: T): React.ReactNode
}

export interface DataListProps<T> {
  /** Accessible name of the list. */
  label: string
  items: readonly T[]
  getKey(item: T): string
  columns: ReadonlyArray<DataColumn<T>>
  title?: string
  description?: React.ReactNode
  /** Buttons at the right of the toolbar (Add, Refresh). */
  actions?: React.ReactNode
  /** Nouns for the count line: ['project', 'projects']. */
  noun?: readonly [string, string]
  /** Present: a filter box appears once the list is long enough to need one. */
  filter?(item: T, query: string): boolean
  onRowClick?(item: T): void
  rowMenu?(item: T): ReadonlyArray<RowMenuItem | false | null | undefined>
  /** Dims a row (an inactive or overridden item). */
  isMuted?(item: T): boolean
  loading?: boolean
  empty?: React.ReactNode
  /** Draws column headers. Off for single-column lists. */
  showHeader?: boolean
  anchor?: string
}

const FILTER_THRESHOLD = 8
const VIRTUAL_THRESHOLD = 60

export function DataList<T>(props: DataListProps<T>): React.JSX.Element {
  const { label, items, getKey, columns, title, description, actions, noun, filter, onRowClick, rowMenu, isMuted, loading, empty, showHeader, anchor } = props
  const colors = useColors()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const visible = useMemo(() => (filter && q ? items.filter((i) => filter(i, q)) : items), [items, filter, q])
  const hasMenu = rowMenu !== undefined
  const template = [
    ...columns.map((c, i) => c.width ?? (i === 0 ? 'minmax(0, 1fr)' : 'auto')),
    ...(hasMenu ? [`${KIT.controlHeight}px`] : []),
  ].join(' ')
  const showFilter = filter !== undefined && items.length >= FILTER_THRESHOLD
  const count = noun ? `${q ? `${visible.length} of ` : ''}${items.length} ${items.length === 1 ? noun[0] : noun[1]}` : null

  return (
    <section aria-label={label} data-settings-anchor={anchor}>
      <GroupHeader title={title} description={description} />
      <div style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.groupRadius, background: colors.surfacePrimary, overflow: 'hidden' }}>
        {(count || showFilter || actions) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `6px 6px 6px ${KIT.inset}px`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
            {count && <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, whiteSpace: 'nowrap' }}>{count}</span>}
            <div style={{ flex: 1 }} />
            {showFilter && (
              <div style={{ position: 'relative', width: 200 }}>
                <MagnifyingGlass size={12} style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', color: colors.textTertiary, pointerEvents: 'none' }} />
                <input
                  aria-label={`Filter ${label}`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter"
                  style={{ width: '100%', height: KIT.controlHeight, boxSizing: 'border-box', padding: '0 8px 0 24px', fontSize: KIT.fontSmall, color: colors.textPrimary, background: colors.inputBg, border: `1px solid ${colors.inputBorder}`, borderRadius: KIT.radius, outline: 'none' }}
                />
              </div>
            )}
            {actions && <div style={{ display: 'flex', gap: 6 }}>{actions}</div>}
          </div>
        )}
        {showHeader && visible.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: template, columnGap: 12, alignItems: 'center', height: 26, padding: `0 6px 0 ${KIT.inset}px`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
            {columns.map((c) => <div key={c.id} style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase', color: colors.textTertiary, textAlign: c.align === 'end' ? 'right' : 'left', whiteSpace: 'nowrap' }}>{c.header ?? ''}</div>)}
            {hasMenu && <div />}
          </div>
        )}
        {loading && items.length === 0 ? (
          <div style={{ padding: `10px ${KIT.inset}px`, fontSize: KIT.fontSmall, color: colors.textTertiary }}>Loading…</div>
        ) : visible.length === 0 ? (
          q ? <EmptyState title="Nothing matches" detail={`No ${noun?.[1] ?? 'items'} match “${query.trim()}”.`} /> : (empty ?? <EmptyState title="Nothing here yet" />)
        ) : (
          <Rows
            items={visible}
            render={(item) => (
              <DataRow
                key={getKey(item)}
                item={item}
                columns={columns}
                template={template}
                onClick={onRowClick}
                menu={rowMenu?.(item)}
                hasMenu={hasMenu}
                muted={isMuted?.(item) ?? false}
              />
            )}
          />
        )}
      </div>
    </section>
  )
}

function Rows<T>({ items, render }: { items: readonly T[]; render(item: T): React.ReactNode }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtual = items.length > VIRTUAL_THRESHOLD
  const virtualizer = useVirtualizer({ count: virtual ? items.length : 0, getScrollElement: () => scrollRef.current, estimateSize: () => KIT.rowHeight, overscan: 8 })
  if (!virtual) {
    return <div role="list" style={{ maxHeight: KIT.listMaxHeight, overflowY: 'auto' }}>{items.map(render)}</div>
  }
  return (
    <div ref={scrollRef} role="list" style={{ height: KIT.listMaxHeight, overflowY: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div key={v.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}>{render(items[v.index])}</div>
        ))}
      </div>
    </div>
  )
}

function DataRow<T>({ item, columns, template, onClick, menu, hasMenu, muted }: {
  item: T
  columns: ReadonlyArray<DataColumn<T>>
  template: string
  onClick?(item: T): void
  menu?: ReadonlyArray<RowMenuItem | false | null | undefined>
  hasMenu: boolean
  muted: boolean
}): React.JSX.Element {
  const colors = useColors()
  const { hover, handlers } = useInteractiveState()
  const clickable = onClick !== undefined
  return (
    <div
      role="listitem"
      tabIndex={clickable ? 0 : undefined}
      className={clickable ? 'ion-focusable' : undefined}
      onClick={clickable ? () => onClick(item) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onClick(item) } : undefined}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      style={{
        display: 'grid', gridTemplateColumns: template, columnGap: 12, alignItems: 'center',
        height: KIT.rowHeight, padding: `0 6px 0 ${KIT.inset}px`, boxSizing: 'border-box',
        borderBottom: `1px solid ${colors.borderSubtle}`, fontSize: KIT.fontSmall, color: colors.textSecondary,
        background: clickable && hover ? colors.surfaceHover : 'transparent', cursor: clickable ? 'pointer' : 'default',
        opacity: muted ? 0.6 : 1, transition: `background ${transitions.base}`,
      }}
    >
      {columns.map((c, i) => (
        <div key={c.id} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, justifyContent: c.align === 'end' ? 'flex-end' : 'flex-start', overflow: 'hidden', whiteSpace: 'nowrap', color: i === 0 ? colors.textPrimary : undefined, fontSize: i === 0 ? KIT.font : undefined }}>
          {c.render(item)}
        </div>
      ))}
      {hasMenu && <div onClick={(e) => e.stopPropagation()}>{menu && <RowMenu items={menu} />}</div>}
    </div>
  )
}

/** Truncating text for a list cell; the full value is its tooltip. */
export function CellText({ children, mono, muted }: { children: string; mono?: boolean; muted?: boolean }): React.JSX.Element {
  const colors = useColors()
  return (
    <Tooltip text={children} style={{ minWidth: 0, overflow: 'hidden', display: 'flex' }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: mono ? KIT.mono : undefined, fontSize: mono ? KIT.fontTiny : undefined, color: muted ? colors.textTertiary : undefined }}>{children}</span>
    </Tooltip>
  )
}
