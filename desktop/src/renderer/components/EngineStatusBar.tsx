import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { Reorder } from 'framer-motion'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import type { EngineInstance } from '../../shared/types'

interface Props {
  tabId: string
}

export function EngineStatusBar({ tabId }: Props) {
  const colors = useColors()
  const pane = useSessionStore((s) => s.enginePanes.get(tabId))
  const instances = pane?.instances || []
  const activeId = pane?.activeInstanceId || null

  const scrollRef = useRef<HTMLDivElement>(null)

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!scrollRef.current || e.deltaY === 0) return
    e.preventDefault()
    scrollRef.current.scrollLeft += e.deltaY
  }, [])

  useEffect(() => {
    if (!activeId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-engine-tab-id="${activeId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const startRename = (inst: EngineInstance) => {
    setEditingId(inst.id)
    setEditLabel(inst.label)
  }

  const finishRename = () => {
    if (editingId && editLabel.trim()) {
      useSessionStore.getState().renameEngineInstance(tabId, editingId, editLabel.trim())
    }
    setEditingId(null)
  }

  const renderTab = (inst: EngineInstance) => {
    const isActive = inst.id === activeId
    return (
      <Reorder.Item
        key={inst.id}
        value={inst}
        as="div"
        dragListener={editingId !== inst.id}
        dragConstraints={{ top: 0, bottom: 0 }}
        data-ion-ui
        data-engine-tab-id={inst.id}
        onClick={() => useSessionStore.getState().selectEngineInstance(tabId, inst.id)}
        onDoubleClick={() => startRename(inst)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 6,
          cursor: editingId === inst.id ? 'text' : 'grab',
          fontSize: 11,
          fontWeight: isActive ? 600 : 400,
          color: isActive ? colors.textPrimary : colors.textSecondary,
          background: isActive ? colors.accent + '20' : 'transparent',
          border: isActive ? `1px solid ${colors.accent}40` : '1px solid transparent',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        {editingId === inst.id ? (
          <input
            data-ion-ui
            autoFocus
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onBlur={finishRename}
            onKeyDown={(e) => { if (e.key === 'Enter') finishRename(); if (e.key === 'Escape') setEditingId(null) }}
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: colors.textPrimary,
              fontSize: 11,
              fontWeight: 600,
              width: 60,
              padding: 0,
            }}
          />
        ) : (
          <span>{inst.label}</span>
        )}
        {/* Close button */}
        <button
          data-ion-ui
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); useSessionStore.getState().removeEngineInstance(tabId, inst.id) }}
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
          <X size={10} />
        </button>
      </Reorder.Item>
    )
  }

  return (
    <div
      data-ion-ui
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 28,
        padding: '0 8px',
        borderBottom: `1px solid ${colors.containerBorder}`,
        background: colors.containerBg,
        gap: 2,
        flexShrink: 0,
      }}
    >
      <div style={{ position: 'relative', minWidth: 0, flex: 1 }}>
        <Reorder.Group
          as="div"
          axis="x"
          values={instances}
          onReorder={(reordered) => useSessionStore.getState().reorderEngineInstances(tabId, reordered)}
          ref={scrollRef}
          onWheel={onWheel}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            overflowX: 'auto',
            minWidth: 0,
            scrollbarWidth: 'none',
            maskImage: 'linear-gradient(to right, black 0%, black calc(100% - 24px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black calc(100% - 24px), transparent 100%)',
            listStyle: 'none',
            padding: 0,
            margin: 0,
          }}
        >
          {instances.map(renderTab)}
          {/* Add instance button */}
          <button
            data-ion-ui
            onClick={() => useSessionStore.getState().addEngineInstance(tabId)}
            title="New engine instance"
            style={{
              background: 'none',
              border: 'none',
              padding: '2px 4px',
              cursor: 'pointer',
              color: colors.textTertiary,
              display: 'flex',
              alignItems: 'center',
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            <Plus size={12} />
          </button>
        </Reorder.Group>
      </div>
    </div>
  )
}
