import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { Reorder } from 'framer-motion'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import type { EngineInstance } from '../../shared/types'
import { getEngineInstanceWaitingState } from './TabStripShared'

interface Props {
  tabId: string
}

export function EngineStatusBar({ tabId }: Props) {
  const colors = useColors()
  const pane = useSessionStore((s) => s.enginePanes.get(tabId))
  const instances = pane?.instances || []
  const activeId = pane?.activeInstanceId || null
  const tabs = useSessionStore((s) => s.tabs)
  // Subscribe to enginePermissionDenied so the per-instance status dot
  // re-renders when this tab's instances acquire or clear a pending
  // AskUserQuestion / ExitPlanMode denial. The map identity changes on
  // every write in engine-event-slice.ts.
  useSessionStore((s) => s.enginePermissionDenied)
  // Other engine tabs this instance can be moved to
  const engineTargetTabs = tabs.filter((t) => t.isEngine && t.id !== tabId)

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
  const [contextMenu, setContextMenu] = useState<{ instId: string; x: number; y: number } | null>(null)

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

  const handleContextMenu = useCallback((e: React.MouseEvent, inst: EngineInstance) => {
    if (engineTargetTabs.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ instId: inst.id, x: e.clientX, y: e.clientY })
  }, [engineTargetTabs])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const renderTab = (inst: EngineInstance) => {
    const isActive = inst.id === activeId
    // Per-instance waiting-state dot. 'question' (yellow/orange) and
    // 'plan-ready' (green) mirror the parent-tab pill glow palette in
    // TabStripStatusDot.tsx. Null = no dot. Engine sub-tabs are
    // independent sub-conversations, so the dot is scoped to whichever
    // instance has the pending denial. The parent-tab pill in TabStrip
    // bubbles "any instance waiting" via getWaitingState().
    const waitingState = getEngineInstanceWaitingState(`${tabId}:${inst.id}`)
    const dotColor =
      waitingState === 'question' ? colors.infoText :
        waitingState === 'plan-ready' ? colors.statusComplete :
          null
    const dotGlow =
      waitingState === 'question' ? colors.tabGlowQuestion :
        waitingState === 'plan-ready' ? colors.tabGlowPlanReady :
          null
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
        onContextMenu={(e) => handleContextMenu(e, inst)}
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
        {dotColor && (
          <span
            className="flex-shrink-0"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: dotColor,
              ...(dotGlow ? { boxShadow: `0 0 6px 2px ${dotGlow}` } : {}),
            }}
          />
        )}
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
    <>
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
      {/* Context menu: Move to another engine tab */}
      {contextMenu && (
        <div
          data-ion-ui
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: colors.containerBg,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 9999,
            minWidth: 140,
            padding: '4px 0',
          }}
          onMouseLeave={closeContextMenu}
        >
          <div style={{ padding: '2px 12px 4px', fontSize: 10, color: colors.textTertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Move to
          </div>
          {engineTargetTabs.map((t) => (
            <button
              key={t.id}
              data-ion-ui
              onClick={() => {
                useSessionStore.getState().moveEngineInstance(tabId, contextMenu.instId, t.id)
                closeContextMenu()
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                padding: '5px 12px',
                cursor: 'pointer',
                fontSize: 12,
                color: colors.textPrimary,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = colors.accent + '20' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
            >
              {t.customTitle || t.title}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
