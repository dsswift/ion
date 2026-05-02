import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowsOutSimple, ArrowsInSimple, CaretDown, Check } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { useSessionStore, AVAILABLE_MODELS, getModelDisplayLabel } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import type { StatusFields } from '../../shared/types'

interface Props {
  status: StatusFields | null
  isTall: boolean
  onToggleTall: () => void
  activeTabId: string
  engineModelOverride?: string
}

function renderContextBar(percent: number): string {
  const filled = Math.round(percent / 10)
  const empty = 10 - filled
  return '[' + '#'.repeat(filled) + '.'.repeat(empty) + '] ' + percent + '%'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

export function EngineFooter({ status, isTall, onToggleTall, activeTabId, engineModelOverride }: Props) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const setEngineModel = useSessionStore((s) => s.setEngineModel)
  const engineDefaultModel = usePreferencesStore((s) => s.engineDefaultModel)

  const [hover, setHover] = useState(false)
  const barRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  // Model picker state
  const [modelOpen, setModelOpen] = useState(false)
  const modelTriggerRef = useRef<HTMLSpanElement>(null)
  const modelPopoverRef = useRef<HTMLDivElement>(null)
  const [modelPos, setModelPos] = useState({ bottom: 0, left: 0 })

  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const selectedModel = engineModelOverride || engineDefaultModel || preferredModel || AVAILABLE_MODELS[1].id
  const selectedLabel = getModelDisplayLabel(selectedModel)

  const isBusy = status?.state === 'running'

  const updateModelPos = useCallback(() => {
    if (!modelTriggerRef.current) return
    const rect = modelTriggerRef.current.getBoundingClientRect()
    setModelPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
  }, [])

  useEffect(() => {
    if (!modelOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (modelTriggerRef.current?.contains(target)) return
      if (modelPopoverRef.current?.contains(target)) return
      setModelOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelOpen])

  const handleModelToggle = () => {
    if (isBusy) return
    if (!modelOpen) updateModelPos()
    setModelOpen((o) => !o)
  }

  const handleBarEnter = () => {
    if (barRef.current) {
      const rect = barRef.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left + rect.width / 2 })
    }
    setHover(true)
  }

  const pct = status?.contextPercent ?? 0
  const cw = status?.contextWindow ?? 0
  const tokens = cw > 0 ? pct * cw / 100 : 0
  const tooltip = cw > 0
    ? `${formatTokens(tokens)} / ${formatTokens(cw)} tokens`
    : `${pct}% context used`

  // Check if the engine's actual model differs from the user's selection
  const actualModel = status?.model
  const actualLabel = actualModel ? getModelDisplayLabel(actualModel) : null
  const modelDiffers = actualModel && actualLabel !== selectedLabel

  return (
    <div
      data-ion-ui
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 24,
        borderTop: `1px solid ${colors.containerBorder}`,
        padding: '0 12px',
        fontSize: 11,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {/* Left: label, state, team, model picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
        {status ? (
          <>
            {status.extensionName && (
              <span style={{ color: colors.accent, fontWeight: 600 }}>{status.extensionName}</span>
            )}
            <span style={{ color: colors.textTertiary }}>[{status.state}]</span>
            {status.team && <>
              <span style={{ color: colors.textTertiary }}>|</span>
              <span style={{ color: colors.textSecondary }}>{status.team}</span>
            </>}
            <span style={{ color: colors.textTertiary }}>|</span>
            <span
              ref={modelTriggerRef}
              role="button"
              onClick={handleModelToggle}
              style={{
                cursor: isBusy ? 'not-allowed' : 'pointer',
                color: colors.textSecondary,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
              title={isBusy ? 'Stop the task to change model' : 'Switch model'}
            >
              {selectedLabel}
              {modelDiffers && (
                <span style={{ color: colors.textTertiary, fontSize: 10 }}>({actualLabel})</span>
              )}
              <CaretDown size={9} style={{ opacity: 0.6 }} />
            </span>
            {status.backend !== 'api' && <>
              <span style={{ color: colors.textTertiary }}>|</span>
              <span style={{ color: '#e5a100', fontSize: 10, fontWeight: 500 }}>via CLI</span>
            </>}
          </>
        ) : (
          <span style={{ color: colors.textTertiary }}>--</span>
        )}
      </div>

      {/* Right: context bar, cost, toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {status && (
          <>
            <span
              ref={barRef}
              style={{ fontFamily: 'monospace', fontSize: 10, color: colors.textTertiary, cursor: 'default' }}
              onMouseEnter={handleBarEnter}
              onMouseLeave={() => setHover(false)}
            >
              {renderContextBar(status.contextPercent)}
            </span>
            {popoverLayer && hover && createPortal(
              <div
                style={{
                  position: 'fixed',
                  bottom: pos.bottom,
                  left: pos.left,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  background: colors.popoverBg,
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  border: `1px solid ${colors.popoverBorder}`,
                  borderRadius: 6,
                  padding: '3px 8px',
                  fontSize: 10,
                  color: colors.textSecondary,
                  whiteSpace: 'nowrap',
                  boxShadow: colors.popoverShadow,
                }}
              >
                {tooltip}
              </div>,
              popoverLayer,
            )}
            {status.totalCostUsd != null && status.totalCostUsd > 0 && (
              <span style={{ color: colors.textTertiary, fontSize: 10 }}>
                ${status.totalCostUsd.toFixed(2)}
              </span>
            )}
          </>
        )}
        <button
          data-ion-ui
          onClick={onToggleTall}
          title={isTall ? 'Collapse view' : 'Expand view'}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: colors.textTertiary,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {isTall ? <ArrowsInSimple size={12} /> : <ArrowsOutSimple size={12} />}
        </button>
      </div>

      {/* Model picker popover */}
      {popoverLayer && modelOpen && createPortal(
        <motion.div
          ref={modelPopoverRef}
          data-ion-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: modelPos.bottom,
            left: modelPos.left,
            width: 192,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            {AVAILABLE_MODELS.map((m) => {
              const isSelected = selectedModel === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => { setEngineModel(activeTabId, m.id); setModelOpen(false) }}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                  style={{
                    color: isSelected ? colors.textPrimary : colors.textSecondary,
                    fontWeight: isSelected ? 600 : 400,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {m.label}
                  {isSelected && <Check size={12} style={{ color: colors.accent }} />}
                </button>
              )
            })}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </div>
  )
}
