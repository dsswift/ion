import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Plus, X, LockSimple, LockSimpleOpen, ArrowsOutSimple, ArrowsInSimple, ArrowsOut, ArrowsIn } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import type { TerminalInstance } from '../../shared/types'

interface Props {
  tabId: string
}

export function TerminalStatusBar({ tabId }: Props) {
  const colors = useColors()
  const pane = useSessionStore((s) => s.terminalPanes.get(tabId))
  const terminalTallTabId = useSessionStore((s) => s.terminalTallTabId)
  const terminalBigScreenTabId = useSessionStore((s) => s.terminalBigScreenTabId)
  const {
    addTerminalInstance,
    removeTerminalInstance,
    selectTerminalInstance,
    toggleTerminalReadOnly,
    toggleTerminalTall,
    toggleTerminalBigScreen,
  } = useSessionStore.getState()

  const isTall = terminalTallTabId === tabId
  const isBigScreen = terminalBigScreenTabId === tabId

  const instances = pane?.instances || []
  const activeId = pane?.activeInstanceId || null

  // Split into user tabs (left) and system tabs (right)
  const userTabs = instances.filter((i) => i.kind === 'user')
  const systemTabs = instances.filter((i) => i.kind !== 'user')
  const hasBothSections = userTabs.length > 0 && systemTabs.length > 0

  const scrollRef = useRef<HTMLDivElement>(null)

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!scrollRef.current || e.deltaY === 0) return
    e.preventDefault()
    scrollRef.current.scrollLeft += e.deltaY
  }, [])

  useEffect(() => {
    if (!activeId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-terminal-tab-id="${activeId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const startRename = (inst: TerminalInstance) => {
    setEditingId(inst.id)
    setEditLabel(inst.label)
  }

  const finishRename = () => {
    if (editingId && editLabel.trim()) {
      useSessionStore.getState().renameTerminalInstance(tabId, editingId, editLabel.trim())
    }
    setEditingId(null)
  }

  const renderTab = (inst: TerminalInstance) => {
    const isActive = inst.id === activeId
    return (
      <div
        key={inst.id}
        data-coda-ui
        data-terminal-tab-id={inst.id}
        onClick={() => selectTerminalInstance(tabId, inst.id)}
        onDoubleClick={() => startRename(inst)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 11,
          fontWeight: isActive ? 600 : 400,
          color: isActive ? colors.textPrimary : colors.textSecondary,
          background: isActive ? colors.accent + '20' : 'transparent',
          border: isActive ? `1px solid ${colors.accent}40` : '1px solid transparent',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        {editingId === inst.id ? (
          <input
            data-coda-ui
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
        {/* Read-only toggle */}
        <button
          data-coda-ui
          onClick={(e) => { e.stopPropagation(); toggleTerminalReadOnly(tabId, inst.id) }}
          title={inst.readOnly ? 'Read-only (click to edit)' : 'Editable (click to lock)'}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: inst.readOnly ? colors.accent : colors.textTertiary,
            display: 'flex',
            alignItems: 'center',
            opacity: inst.readOnly ? 1 : 0.5,
          }}
        >
          {inst.readOnly ? <LockSimple size={10} weight="bold" /> : <LockSimpleOpen size={10} />}
        </button>
        {/* Close button */}
        <button
          data-coda-ui
          onClick={(e) => { e.stopPropagation(); removeTerminalInstance(tabId, inst.id) }}
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
      </div>
    )
  }

  return (
    <div
      data-coda-ui
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
      {/* Left section: user tabs */}
      <div style={{ position: 'relative', minWidth: 0, flex: 1 }}>
        <div
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
          }}
        >
          {userTabs.map(renderTab)}
          {/* Add terminal button */}
          <button
            data-coda-ui
            onClick={() => addTerminalInstance(tabId, 'user')}
            title="New terminal"
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
        </div>
      </div>

      {/* Separator */}
      {hasBothSections && (
        <div style={{ width: 1, height: 14, background: colors.containerBorder, margin: '0 4px', flexShrink: 0 }} />
      )}

      {/* Right section: system tabs (pinned right-to-left) */}
      {systemTabs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {systemTabs.map(renderTab)}
        </div>
      )}

      {/* Separator before controls */}
      <div style={{ width: 1, height: 14, background: colors.containerBorder, margin: '0 4px', flexShrink: 0 }} />

      {/* Make Tall button (hidden in big screen mode) */}
      {!isBigScreen && (
        <button
          data-coda-ui
          onClick={() => toggleTerminalTall(tabId)}
          title={isTall ? 'Exit tall mode' : 'Make tall'}
          style={{
            background: 'none',
            border: 'none',
            padding: '2px 4px',
            cursor: 'pointer',
            color: isTall ? colors.accent : colors.textTertiary,
            display: 'flex',
            alignItems: 'center',
            borderRadius: 4,
          }}
        >
          {isTall ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}
        </button>
      )}

      {/* Big Screen button */}
      <button
        data-coda-ui
        onClick={() => toggleTerminalBigScreen(tabId)}
        title={isBigScreen ? 'Exit big screen' : 'Big screen'}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 4px',
          cursor: 'pointer',
          color: isBigScreen ? colors.accent : colors.textTertiary,
          display: 'flex',
          alignItems: 'center',
          borderRadius: 4,
        }}
      >
        {isBigScreen ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
      </button>
    </div>
  )
}
