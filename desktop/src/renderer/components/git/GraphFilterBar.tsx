import React, { useState, useCallback, useRef, useEffect } from 'react'
import { MagnifyingGlass, X, User, FunnelSimple, Folder, Calendar } from '@phosphor-icons/react'
import { useColors } from '../../theme'

interface GraphFilterBarProps {
  onFilterChange: (filters: GraphFilters) => void
  filters: GraphFilters
}

export interface GraphFilters {
  search: string
  author: string
  path?: string
  refKind?: 'all' | 'head' | 'branches' | 'tags'
  dateAfter?: string
  dateBefore?: string
  datePreset?: 'today' | 'week' | 'month' | 'custom' | ''
}

export const EMPTY_FILTERS: GraphFilters = { search: '', author: '', path: '', refKind: 'all', datePreset: '' }

function presetRange(preset: GraphFilters['datePreset']): { after?: string; before?: string } {
  if (!preset || preset === 'custom') return {}
  const now = new Date()
  let after: Date | null = null
  if (preset === 'today') { after = new Date(now); after.setHours(0, 0, 0, 0) }
  if (preset === 'week') { after = new Date(now); after.setDate(after.getDate() - 7) }
  if (preset === 'month') { after = new Date(now); after.setMonth(after.getMonth() - 1) }
  return { after: after?.toISOString() }
}

export function GraphFilterBar({ onFilterChange, filters }: GraphFilterBarProps) {
  const colors = useColors()
  const [expanded, setExpanded] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasFilters = !!(filters.search || filters.author || filters.path || (filters.refKind && filters.refKind !== 'all') || filters.dateAfter)

  const apply = useCallback((partial: Partial<GraphFilters>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const next = { ...filters, ...partial }
      if (partial.datePreset) {
        const r = presetRange(partial.datePreset)
        next.dateAfter = r.after ?? ''
        next.dateBefore = r.before ?? ''
      }
      onFilterChange(next)
    }, 200)
  }, [filters, onFilterChange])

  const handleClear = useCallback(() => { onFilterChange(EMPTY_FILTERS); setExpanded(false) }, [onFilterChange])

  useEffect(() => {
    if (expanded && searchRef.current) searchRef.current.focus()
  }, [expanded])

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="p-0.5 rounded transition-colors relative"
        style={{ color: hasFilters ? colors.accent : colors.textTertiary }}
        title="Filter commits"
      >
        <FunnelSimple size={11} />
        {hasFilters && <div style={{ position: 'absolute', top: 0, right: 0, width: 4, height: 4, borderRadius: 2, background: colors.accent }} />}
      </button>
    )
  }

  const chipStyle: React.CSSProperties = { color: colors.textPrimary, background: colors.surfaceSecondary, border: `1px solid ${colors.containerBorder}`, padding: '1px 4px', borderRadius: 3, fontSize: 10 }

  return (
    <div className="flex items-center gap-1 px-2 flex-wrap" style={{ minHeight: 24, flexShrink: 0, borderBottom: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary, padding: '4px 8px' }}>
      <MagnifyingGlass size={10} style={{ color: colors.textTertiary }} />
      <input ref={searchRef} defaultValue={filters.search} onChange={(e) => apply({ search: e.target.value })} placeholder="Subject…" className="text-[10px] bg-transparent outline-none" style={{ color: colors.textPrimary, flex: 1, minWidth: 60 }} />

      <User size={10} style={{ color: colors.textTertiary }} />
      <input defaultValue={filters.author} onChange={(e) => apply({ author: e.target.value })} placeholder="Author" className="text-[10px] bg-transparent outline-none" style={{ color: colors.textPrimary, width: 70 }} />

      <Folder size={10} style={{ color: colors.textTertiary }} />
      <input defaultValue={filters.path ?? ''} onChange={(e) => apply({ path: e.target.value })} placeholder="path/to/file" className="text-[10px] bg-transparent outline-none" style={{ color: colors.textPrimary, width: 110 }} />

      <select value={filters.refKind ?? 'all'} onChange={(e) => apply({ refKind: e.target.value as GraphFilters['refKind'] })} style={chipStyle}>
        <option value="all">all refs</option>
        <option value="head">HEAD</option>
        <option value="branches">branches</option>
        <option value="tags">tags</option>
      </select>

      <Calendar size={10} style={{ color: colors.textTertiary }} />
      <select value={filters.datePreset ?? ''} onChange={(e) => apply({ datePreset: e.target.value as GraphFilters['datePreset'] })} style={chipStyle}>
        <option value="">any time</option>
        <option value="today">today</option>
        <option value="week">past week</option>
        <option value="month">past month</option>
        <option value="custom">custom…</option>
      </select>
      {filters.datePreset === 'custom' && (
        <>
          <input type="date" defaultValue={filters.dateAfter?.slice(0, 10)} onChange={(e) => apply({ dateAfter: e.target.value ? new Date(e.target.value).toISOString() : '' })} style={chipStyle} />
          <input type="date" defaultValue={filters.dateBefore?.slice(0, 10)} onChange={(e) => apply({ dateBefore: e.target.value ? new Date(e.target.value).toISOString() : '' })} style={chipStyle} />
        </>
      )}

      <button onClick={handleClear} className="p-0.5 rounded" style={{ color: colors.textTertiary }} title="Clear filters">
        <X size={10} />
      </button>
    </div>
  )
}
