import React, { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Check, MagnifyingGlass } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useModelStore } from '../stores/model-store'
import { getProviderDisplayName } from '../../shared/types-models'
import { getModelDisplayLabel } from '../stores/model-labels'
import type { ModelEntry } from '../../shared/types-models'

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
  const [search, setSearch] = useState('')

  const providerAuthMap = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const p of providers) map.set(p.id, p.hasAuth)
    return map
  }, [providers])

  const grouped = useMemo(() => {
    const lowered = search.toLowerCase()
    const filtered = models.filter((m) => {
      if (!lowered) return true
      return m.id.toLowerCase().includes(lowered) || getModelDisplayLabel(m.id).toLowerCase().includes(lowered)
    })
    const groups = new Map<string, ModelEntry[]>()
    for (const m of filtered) {
      const list = groups.get(m.providerId) || []
      list.push(m)
      groups.set(m.providerId, list)
    }
    return groups
  }, [models, search])

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
        position: 'fixed',
        bottom: position.bottom,
        left: position.left,
        width: 220,
        maxHeight: 320,
        overflowY: 'auto',
        pointerEvents: 'auto',
        background: colors.popoverBg,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        boxShadow: colors.popoverShadow,
        border: `1px solid ${colors.popoverBorder}`,
      }}
    >
      {showSearch && (
        <div style={{ padding: '6px 8px 2px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <MagnifyingGlass size={12} style={{ color: colors.textTertiary, flexShrink: 0 }} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models…"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: colors.textPrimary,
              fontSize: 11,
              padding: '2px 0',
            }}
          />
        </div>
      )}
      <div className="py-1">
        {Array.from(grouped.entries()).map(([providerId, providerModels]) => {
          const hasAuth = providerAuthMap.get(providerId) ?? false
          return (
            <div key={providerId}>
              <div
                style={{
                  padding: '4px 12px 2px',
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: hasAuth ? colors.textTertiary : colors.textTertiary + '80',
                }}
              >
                {getProviderDisplayName(providerId)}
                {!hasAuth && <span style={{ marginLeft: 4, fontSize: 8, opacity: 0.6 }}>⚠ not configured</span>}
              </div>
              {providerModels.map((m) => {
                const isSelected = m.id === selectedModelId
                return (
                  <button
                    key={m.id}
                    onClick={() => { onSelect(m.id); onClose() }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                    style={{
                      color: isSelected ? colors.textPrimary : hasAuth ? colors.textSecondary : colors.textTertiary,
                      fontWeight: isSelected ? 600 : 400,
                      opacity: hasAuth ? 1 : 0.5,
                      background: 'none',
                      border: 'none',
                      cursor: hasAuth ? 'pointer' : 'default',
                    }}
                    disabled={!hasAuth}
                    title={!hasAuth ? 'Configure this provider in Settings' : undefined}
                  >
                    {getModelDisplayLabel(m.id)}
                    {isSelected && <Check size={12} style={{ color: colors.accent }} />}
                  </button>
                )
              })}
            </div>
          )
        })}
        {grouped.size === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: colors.textTertiary }}>
            No models found
          </div>
        )}
      </div>
    </motion.div>
  )
}
