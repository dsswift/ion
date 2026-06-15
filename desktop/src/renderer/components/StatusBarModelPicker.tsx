import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { CaretDown } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { AVAILABLE_MODELS, getModelDisplayLabel } from '../stores/model-labels'
import { useModelStore } from '../stores/model-store'
import { ModelPickerPopover } from './ModelPickerPopover'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useActiveEngineStatusFields, useActiveEngineKey } from './StatusBarEngineHelpers'
import { activeInstance } from '../stores/conversation-instance'

/* ─── Model Picker (inline — tightly coupled to StatusBar) ─── */

/**
 * Single model picker rendered in the unified `StatusBar` left
 * cluster. Sources state differently depending on the active tab
 * type:
 *
 * - **Conversation tabs**: reads `tab.modelOverride` / `tab.sessionModel`
 *   from the active tab; writes via `setTabModel(activeTabId, modelId)`.
 *
 * - **Engine tabs**: reads `engineModelOverrides[${tabId}:${instanceId}]`
 *   from the active engine instance, falling back to the preferences'
 *   `engineDefaultModel`; writes via `setEngineModel(tabId, modelId)`.
 *   Also shows the `(actualLabel)` parenthetical when the engine's
 *   actual running model (`engineStatusFields[key].model`) differs
 *   from the user's current selection — mirroring the rendering in
 *   the former engine status bar.
 *
 * The popover, busy-state gating, and visual styling are identical for
 * both tab types — only the underlying read/write source changes. This
 * is one component, not a fork: per CLAUDE.md § "Solution quality" we
 * prefer a single component that does the right thing over a "simpler"
 * branch into two near-duplicate files.
 */
export function ModelPicker() {
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const engineDefaultModel = usePreferencesStore((s) => s.engineDefaultModel)
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      if (!t) return undefined
      // Per-conversation model state (`sessionModel` / `modelOverride`) now
      // lives on the active instance, resolved via `activeInstance`.
      const inst = activeInstance(s.conversationPanes, t.id)
      return { status: t.status, sessionModel: inst?.sessionModel ?? null, modelOverride: inst?.modelOverride ?? null, hasEngineExtension: t.hasEngineExtension }
    }),
  )
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setTabModel = useSessionStore((s) => s.setTabModel)
  const setEngineModel = useSessionStore((s) => s.setEngineModel)
  // Engine-only state sources — null on conversation tabs.
  const engineStatus = useActiveEngineStatusFields()
  const engineKey = useActiveEngineKey()
  const engineModelOverride = useSessionStore((s) => {
    if (!engineKey) return undefined
    const pane = s.conversationPanes.get(engineKey.tabId)
    const inst = pane?.instances.find((i) => i.id === engineKey.instanceId)
    return inst?.modelOverride ?? undefined
  })
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const fetchModels = useModelStore((s) => s.fetchModels)
  const hasModels = useModelStore((s) => s.models.length > 0)
  const lastFetched = useModelStore((s) => s.lastFetched)

  // Busy-gating: on conversation tabs we use the tab-level status; on
  // engine tabs we use the active instance's engine status because
  // each instance can be in a different run-state and only the active
  // one gates the picker.
  const isEngine = !!tab?.hasEngineExtension
  const isBusy = isEngine
    ? engineStatus?.state === 'running'
    : (tab?.status === 'running' || tab?.status === 'connecting')

  useEffect(() => {
    if (!hasModels) fetchModels()
  }, [hasModels, fetchModels])

  useEffect(() => {
    if (open && Date.now() - lastFetched > 60_000) fetchModels()
  }, [open, lastFetched, fetchModels])

  useEffect(() => { setOpen(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (isBusy) return
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  // Effective model + display label resolve from per-tab-type sources.
  // Engine tabs fold in `engineDefaultModel` from preferences as a
  // sensible default before falling back to the global `preferredModel`.
  const effectiveModel = isEngine
    ? (engineModelOverride || engineDefaultModel || preferredModel || AVAILABLE_MODELS[0].id)
    : (tab?.modelOverride || preferredModel || AVAILABLE_MODELS[0].id)

  const activeLabel = (() => {
    if (isEngine) {
      // Engine tabs: prefer the active instance's override, then the
      // engine default, then preferred, then sessionModel echo, then
      // the static fallback. Mirrors the resolution order used by the
      // former engine status bar.
      if (engineModelOverride) return getModelDisplayLabel(engineModelOverride)
      if (engineDefaultModel) return getModelDisplayLabel(engineDefaultModel)
      if (preferredModel) return getModelDisplayLabel(preferredModel)
      if (engineStatus?.model) return getModelDisplayLabel(engineStatus.model)
      return AVAILABLE_MODELS[0].label
    }
    // Conversation tabs: original resolution order, unchanged.
    if (tab?.modelOverride) return getModelDisplayLabel(tab.modelOverride)
    if (preferredModel) return getModelDisplayLabel(preferredModel)
    if (tab?.sessionModel) return getModelDisplayLabel(tab.sessionModel)
    return AVAILABLE_MODELS[0].label
  })()

  // On engine tabs only: show the (actualLabel) parenthetical when
  // the engine reports it is actually using a different model than
  // the user's selection. Conversation tabs don't have this signal.
  const actualModel = isEngine ? engineStatus?.model : undefined
  const actualLabel = actualModel ? getModelDisplayLabel(actualModel) : null
  const modelDiffers = isEngine && actualModel && actualLabel !== activeLabel

  const handleSelect = (modelId: string) => {
    if (isEngine) {
      setEngineModel(activeTabId, modelId)
    } else if (activeTabId) {
      setTabModel(activeTabId, modelId)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: colors.textTertiary,
          cursor: isBusy ? 'not-allowed' : 'pointer',
        }}
        title={isBusy ? 'Stop the task to change model' : 'Switch model'}
      >
        {activeLabel}
        {modelDiffers && (
          <span style={{ color: colors.textTertiary, fontSize: 10, opacity: 0.7, marginLeft: 2 }}>
            ({actualLabel})
          </span>
        )}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <ModelPickerPopover
          popoverRef={popoverRef}
          selectedModelId={effectiveModel}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
          position={pos}
        />,
        popoverLayer,
      )}
    </>
  )
}
