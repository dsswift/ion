import React, { useState, useMemo, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Star, MagnifyingGlass, CaretDown, CaretRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useModelStore } from '../stores/model-store'
import { usePreferencesStore } from '../preferences'
import { getProviderDisplayName } from '../../shared/types-models'
import { getModelDisplayLabel } from '../stores/model-labels'
import type { ModelEntry } from '../../shared/types-models'

const COLLAPSED_KEY = 'ion:model-picker-collapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch { return new Set() }
}

function saveCollapsed(set: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])) } catch { /* ignore */ }
}

interface ModelPickerPopoverProps {
  selectedModelId: string
  onSelect: (modelId: string) => void
  onClose: () => void
  position: { bottom: number; left: number }
  popoverRef: React.RefObject<HTMLDivElement | null>
}

export function ModelPickerPopover({ selectedModelId, onSelect, onClose, position, popoverRef }: ModelPickerPopoverProps) {
  const colors = useColors()
  const models = useModelStore((s) => s.models)
  const providers = useModelStore((s) => s.providers)
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(loadCollapsed)

  const toggleCollapsed = useCallback((providerId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(providerId)) next.delete(providerId); else next.add(providerId)
      saveCollapsed(next)
      return next
    })
  }, [])

  const authedProviderIds = useMemo(() => {
    return new Set(providers.filter((p) => p.hasAuth).map((p) => p.id))
  }, [providers])

  const isSearching = search.length > 0

  const grouped = useMemo(() => {
    const lowered = search.toLowerCase()
    const filtered = models.filter((m) => {
      if (!isSearching) return authedProviderIds.has(m.providerId)
      return m.id.toLowerCase().includes(lowered) || getModelDisplayLabel(m.id).toLowerCase().includes(lowered)
    })
    const groups = new Map<string, ModelEntry[]>()
    for (const m of filtered) {
      const list = groups.get(m.providerId) || []
      list.push(m)
      groups.set(m.providerId, list)
    }
    return groups
  }, [models, search, isSearching, authedProviderIds])

  const authedModelCount = useMemo(() => {
    return models.filter((m) => authedProviderIds.has(m.providerId)).length
  }, [models, authedProviderIds])

  const duplicateLabels = useMemo(() => {
    const dupes = new Set<string>()
    for (const [, providerModels] of grouped) {
      const seen = new Map<string, number>()
      for (const m of providerModels) {
        const label = getModelDisplayLabel(m.id)
        seen.set(label, (seen.get(label) || 0) + 1)
      }
      for (const [label, count] of seen) {
        if (count > 1) dupes.add(label)
      }
    }
    return dupes
  }, [grouped])

  const showSearch = models.length > 6

  return (
    <motion.div
      ref={popoverRef}
      data-ion-ui
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.12 }}
      className="rounded-xl"
      style={{
        position: 'fixed', bottom: position.bottom, left: position.left,
        width: 240, maxHeight: 360, overflowY: 'auto', pointerEvents: 'auto',
        background: colors.popoverBg, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        boxShadow: colors.popoverShadow, border: `1px solid ${colors.popoverBorder}`,
      }}
    >
      {showSearch && (
        <div style={{ padding: '6px 8px 2px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <MagnifyingGlass size={12} style={{ color: colors.textTertiary, flexShrink: 0 }} />
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search models…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: colors.textPrimary, fontSize: 11, padding: '2px 0' }} />
        </div>
      )}
      <div style={{ padding: '4px 0' }}>
        {Array.from(grouped.entries()).map(([providerId, providerModels], idx) => {
          const hasAuth = authedProviderIds.has(providerId)
          const isCollapsed = !isSearching && collapsed.has(providerId)
          const Caret = isCollapsed ? CaretRight : CaretDown
          return (
            <div key={providerId}>
              {/* Divider between groups */}
              {idx > 0 && <div style={{ height: 1, background: colors.containerBorder, margin: '4px 10px' }} />}
              {/* Provider header — clickable to collapse */}
              <button
                onClick={() => toggleCollapsed(providerId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                  padding: '5px 10px 3px', background: 'none', border: 'none', cursor: 'pointer',
                }}
              >
                <Caret size={10} weight="bold" style={{ color: colors.textTertiary, flexShrink: 0 }} />
                <span style={{
                  fontSize: 11, fontWeight: 600, color: hasAuth ? colors.textSecondary : colors.textTertiary,
                  letterSpacing: '0.02em',
                }}>
                  {getProviderDisplayName(providerId)}
                </span>
                {!hasAuth && <span style={{ fontSize: 9, color: colors.textTertiary, opacity: 0.6 }}>⚠ not configured</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: colors.textTertiary }}>{providerModels.length}</span>
              </button>
              {/* Model rows */}
              {!isCollapsed && providerModels.map((m) => {
                const isSelected = m.id === selectedModelId
                const isDefault = m.id === preferredModel
                const label = getModelDisplayLabel(m.id)
                const isDupe = duplicateLabels.has(label)
                return (
                  <button
                    key={m.id}
                    onClick={() => { onSelect(m.id); onClose() }}
                    className="w-full flex items-center text-[11px] transition-colors"
                    style={{
                      padding: '3px 12px 3px 24px',
                      color: isSelected ? colors.textPrimary : hasAuth ? colors.textSecondary : colors.textTertiary,
                      fontWeight: isSelected ? 600 : 400,
                      opacity: hasAuth ? 1 : 0.5,
                      background: isSelected ? `${colors.accent}18` : 'none',
                      borderRadius: isSelected ? 4 : 0,
                      border: 'none', cursor: hasAuth ? 'pointer' : 'default',
                      gap: 4, justifyContent: 'flex-start',
                    }}
                    disabled={!hasAuth}
                    title={m.id}
                  >
                    {isDefault && <Star size={10} weight="fill" style={{ color: '#f59e0b', flexShrink: 0 }} />}
                    <span style={{ flex: 1, textAlign: 'left' }}>
                      {label}
                      {isDupe && <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.5, fontFamily: 'monospace' }}>{m.id}</span>}
                    </span>
                    {m.isCustom && (
                      <span style={{ fontSize: 8, fontWeight: 500, padding: '0px 4px', borderRadius: 3, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', flexShrink: 0 }}>
                        custom
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
        {grouped.size === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: colors.textTertiary }}>
            {search ? 'No models found' : 'No providers configured'}
          </div>
        )}
        {!search && authedModelCount > 0 && authedModelCount < models.length && (
          <div style={{ padding: '4px 12px 6px', fontSize: 10, color: colors.textTertiary, borderTop: `1px solid ${colors.containerBorder}`, marginTop: 4 }}>
            Search to see models from other providers
          </div>
        )}
      </div>
    </motion.div>
  )
}
