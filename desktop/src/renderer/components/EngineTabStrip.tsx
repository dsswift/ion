import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Plus, X, Warning } from '@phosphor-icons/react'
import { Reorder } from 'framer-motion'
import { useShallow } from 'zustand/shallow'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import type { ConversationRef } from '../../shared/types'
import { getEngineInstanceWaitingState } from './TabStripShared'
import { Tooltip } from './git/Tooltip'
import { EngineInstanceCloseConfirmDialog } from './EngineInstanceCloseConfirmDialog'

interface Props {
  tabId: string
}

/**
 * Engine sub-tab strip — top-of-view tab strip listing the active tab's
 * engine instances (sub-conversations) as draggable pills.
 *
 * This is a TAB STRIP, not a status bar. It owns its own outer 28px-high
 * container slab (border-bottom, container-bg) because it lives at the
 * top of `EngineView` above the conversation area, mirroring the
 * positioning of `TerminalTabStrip` at the top of `TerminalPanel` and
 * the main app `TabStrip` at the top of the window.
 *
 * iOS counterpart: `EngineInstanceBar.swift` (same role, same data).
 *
 * Behavior:
 * - Drag-to-reorder via framer-motion `Reorder.Group`
 * - Double-click to rename
 * - Per-instance status dot (waiting=`question`/`plan-ready` steady glow,
 *   `running` pulse, otherwise nothing)
 * - Model-fallback ⚠ with tooltip showing requested vs. fallback model
 * - Right-click → "Move to" context menu listing sibling engine tabs
 * - Close (✕) opens the centered confirmation dialog before destroying
 *   the instance (and possibly the parent tab if it's the last instance)
 * - Auto-scroll-into-view when the active instance changes
 * - Trailing `+` button adds a new engine instance to this tab
 */
export function EngineTabStrip({ tabId }: Props) {
  const colors = useColors()
  const pane = useSessionStore((s) => s.conversationPanes.get(tabId))
  const instances = pane?.instances || []
  const activeId = pane?.activeInstanceId || null
  const tabs = useSessionStore((s) => s.tabs)
  // Subscribe to conversationPanes so the per-instance status dot re-renders when
  // permissionDenied or statusFields on any instance changes. Both fields now
  // live on the instance in conversationPanes — identity changes on every dual-write.
  // The `pane` selector above already does this; keeping a named comment here
  // so it's clear we no longer need separate subscriptions to the removed Maps.

  // Project per-instance running state from conversationPanes instances so the
  // renderTab closure can read each pill's state without calling hooks inside
  // .map(). Instance statusFields is set by engine-event-status.ts on every
  // engine_status event. useShallow prevents re-render when pairs don't change.
  const engineStateByInstance = useSessionStore(
    useShallow((s) => {
      const out = new Map<string, string>()
      for (const inst of s.conversationPanes.get(tabId)?.instances || []) {
        const state = inst.statusFields?.state
        if (state) out.set(inst.id, state)
      }
      return out
    }),
  )
  // Subscribe to engineModelFallbacks scoped to this tab's instances.
  // The slice writes per `${tabId}:${instanceId}` so we project by
  // instance id, mirroring the engineStateByInstance pattern above.
  // useShallow keeps render cost low — we only re-render when the
  // {id, info} pairs actually change, not on unrelated session-store
  // writes. See engine-event-slice.ts case 'engine_model_fallback' for
  // the writer and engine-event-status.ts (idle branch) for the clear.
  const modelFallbackByInstance = useSessionStore(
    useShallow((s) => {
      const out = new Map<string, { requestedModel: string; fallbackModel: string }>()
      for (const inst of pane?.instances || []) {
        const fb = s.engineModelFallbacks.get(`${tabId}:${inst.id}`)
        if (fb) out.set(inst.id, { requestedModel: fb.requestedModel, fallbackModel: fb.fallbackModel })
      }
      return out
    }),
  )
  // Other engine tabs this instance can be moved to
  const engineTargetTabs = tabs.filter((t) => t.hasEngineExtension && t.id !== tabId)

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
  // Pending sub-tab close confirmation. The X button on a sub-tab pill
  // sets this; the EngineInstanceCloseConfirmDialog (rendered at the
  // bottom of this component) reads it and gates the actual
  // removeEngineInstance call behind a modal pop-up. We keep the id only
  // and resolve the label/last-instance flag at render time so we don't
  // hold stale references if the underlying instance list changes.
  const [confirmingCloseInstId, setConfirmingCloseInstId] = useState<string | null>(null)

  const startRename = (inst: ConversationRef) => {
    setEditingId(inst.id)
    setEditLabel(inst.label)
  }

  const finishRename = () => {
    if (editingId && editLabel.trim()) {
      useSessionStore.getState().renameEngineInstance(tabId, editingId, editLabel.trim())
    }
    setEditingId(null)
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, inst: ConversationRef) => {
    if (engineTargetTabs.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ instId: inst.id, x: e.clientX, y: e.clientY })
  }, [engineTargetTabs])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const renderTab = (inst: ConversationRef) => {
    const isActive = inst.id === activeId
    // Per-instance waiting-state dot. 'question' (yellow/orange) and
    // 'plan-ready' (green) mirror the parent-tab pill glow palette in
    // TabStripStatusDot.tsx. Null = no dot. Engine sub-tabs are
    // independent sub-conversations, so the dot is scoped to whichever
    // instance has the pending denial. The parent-tab pill in TabStrip
    // bubbles "any instance waiting" via getWaitingState().
    const waitingState = getEngineInstanceWaitingState(tabId, inst.id)
    // Per-instance running indicator. When an engine instance has an
    // active run in flight, surface that on its inner pill so users
    // with multiple engine conversations in one tab can see at a glance
    // which ones are working. Sourced from the engine_status snapshot
    // map (populated in engine-event-slice.ts case 'engine_status'),
    // which is the same authoritative idle/running signal that drives
    // the outer tab pill and the EngineView Interrupt button. Only
    // shown when the waiting-state dot isn't already taking the slot —
    // 'question' / 'plan-ready' are stickier user-facing states and
    // win the dot for the same reasons TabStripStatusDot prefers them
    // over the running dot.
    const engineState = engineStateByInstance.get(inst.id)
    const isRunningState =
      engineState === 'running' || engineState === 'starting' || engineState === 'connecting'
    const dotColor =
      waitingState === 'question' ? colors.infoText :
        waitingState === 'plan-ready' ? colors.statusComplete :
          isRunningState ? colors.statusRunning :
            null
    const dotGlow =
      waitingState === 'question' ? colors.tabGlowQuestion :
        waitingState === 'plan-ready' ? colors.tabGlowPlanReady :
          null
    // Pulse the dot only for the live "running" indicator — the waiting
    // dots use the steady glow established by TabStripStatusDot to
    // distinguish "the engine is doing work" from "the engine is
    // waiting on you".
    const dotPulse = !waitingState && isRunningState
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
            className={`flex-shrink-0 ${dotPulse ? 'animate-pulse-dot' : ''}`}
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
        {/* Model-fallback indicator. The engine emits engine_model_fallback
            when a dispatched run's requested model didn't resolve to a
            provider and the runloop fell back to the engine's configured
            defaultModel. This client's policy is to display a small ⚠
            glyph on the affected instance pill until the next idle
            transition. Per CLAUDE.md § "The typed-event corollary", that
            policy is one consumer's choice — headless harnesses are
            free to react differently or ignore the event. */}
        {(() => {
          const fb = modelFallbackByInstance.get(inst.id)
          if (!fb) return null
          return (
            <Tooltip text={`Requested model "${fb.requestedModel}" not configured; running with default "${fb.fallbackModel}"`}>
              <span
                data-ion-ui
                data-testid={`model-fallback-warning-${inst.id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: colors.infoText,
                  flexShrink: 0,
                }}
              >
                <Warning size={11} weight="fill" />
              </span>
            </Tooltip>
          )
        })()}
        {/* Close button. Sets pending-close state so the
            EngineInstanceCloseConfirmDialog (rendered below) can confirm
            the destructive action via a centered modal. We deliberately
            do NOT call removeEngineInstance directly here — closing a
            sub-tab is just as destructive as closing the parent tab (and
            removing the last instance closes the parent tab too via
            engine-slice.ts), so a stray click on a tiny icon should not
            be enough to lose work. */}
        <button
          data-ion-ui
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setConfirmingCloseInstId(inst.id) }}
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
      {/* Top-of-view tab strip slab. Mirrors `TerminalTabStrip` and the
          main app `TabStrip`: fixed 28px height, container-bg fill, a
          subtle bottom border to separate the strip from the
          conversation area below. The inner Reorder.Group is
          horizontally scrollable with a fade mask on the right edge so
          a tab with many engine instances stays usable. */}
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
      {/* Close-instance confirmation modal. Rendered here (not inside
          the Reorder.Item) so the dialog markup is outside the small
          draggable pill — keeps the modal lifecycle decoupled from
          instance reorders and avoids portal-anchor surprises. The
          dialog re-resolves the instance from `instances` on every
          render so a concurrent removal or rename doesn't strand the
          modal with stale data. */}
      {(() => {
        if (!confirmingCloseInstId) return null
        const inst = (pane?.instances || []).find((i) => i.id === confirmingCloseInstId)
        if (!inst) {
          // Instance vanished (race with a remote removal, tab close,
          // etc.). Drop the pending state so we don't render an empty
          // dialog on the next paint.
          return null
        }
        const parentTab = tabs.find((t) => t.id === tabId)
        const parentTitle = parentTab?.customTitle || parentTab?.title || 'engine tab'
        const isLast = (pane?.instances.length || 0) <= 1
        return (
          <EngineInstanceCloseConfirmDialog
            instanceLabel={inst.label}
            tabTitle={parentTitle}
            isLastInstance={isLast}
            onConfirm={() => {
              useSessionStore.getState().removeEngineInstance(tabId, confirmingCloseInstId)
              setConfirmingCloseInstId(null)
            }}
            onCancel={() => setConfirmingCloseInstId(null)}
          />
        )
      })()}
    </>
  )
}
