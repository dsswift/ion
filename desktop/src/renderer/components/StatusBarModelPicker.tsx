import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import { CaretDown } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { resolveModelDisplayLabel } from '../../shared/model-identity'
import { useAllowedModels } from '../stores/use-allowed-models'
import { useModelStore } from '../stores/model-store'
import { ModelPickerPopover } from './ModelPickerPopover'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { usePreferencesStore } from '../preferences'
import { rError, rInfo } from '../rendererLogger'
import { useActiveEngineStatusFields } from './StatusBarEngineHelpers'
import { activeInstance } from '../stores/conversation-instance'
import { tabHasExtensions } from '../../shared/tab-predicates'
import {
  estimateModelSwitchCost,
  formatModelSwitchCost,
  type ModelSwitchCostEstimate,
} from '../../shared/model-switch-cost'
import { resolveContextInputs } from './context-usage'
import { ConfirmDialog } from './git/ConfirmDialog'

/* ─── Model Picker (inline — tightly coupled to StatusBar) ─── */

/**
 * Single model picker rendered in the unified `StatusBar` left cluster. There
 * is no tab-type read/write fork — the per-conversation model lives on the
 * active conversation INSTANCE for every tab:
 *
 * - Reads `inst.modelOverride` / `inst.sessionModel` (via `activeInstance`) for
 *   every tab; writes via `setTabModel(activeTabId, modelId)`, which commits the
 *   active instance's `modelOverride`.
 * - `harnessGoverned` (a DATA predicate: does an extension/harness govern this
 *   conversation?) only folds in the preferences' `engineDefaultModel` as a
 *   default and is never a read/write fork.
 * - Shows the `(actualLabel)` parenthetical when the engine reports a different
 *   running model (`engineStatusFields.model`) than the current selection. That
 *   is pure data — null for a plain conversation, so the parenthetical
 *   self-hides.
 *
 * The popover, busy-state gating, and visual styling are identical for every
 * tab type.
 */
export function ModelPicker() {
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const engineDefaultModel = usePreferencesStore((s) => s.engineDefaultModel)
  // Enterprise-filtered model list (D-011). Full AVAILABLE_MODELS when no
  // enterprise policy is active; only permitted models when it is.
  const allowedModels = useAllowedModels()
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      if (!t) return undefined
      // Per-conversation model state (`sessionModel` / `modelOverride`) lives on
      // the active instance for EVERY tab type, resolved via `activeInstance`.
      const inst = activeInstance(s.conversationPanes, t.id)
      // `harnessGoverned` is a DATA predicate — does an extension/harness govern
      // this conversation's model? — used only for the engine-default fallback
      // and the "engine reports a different model" parenthetical, never as a
      // read/write fork. The model itself is read + written the same way for all.
      // contextTokens is the conversation's model-visible size — the exact
      // token count a model switch would re-send. resolveContextInputs is the
      // same helper the context indicator and status drawer use, so the
      // warning cannot quote a different number than the UI shows.
      return { status: t.status, sessionModel: inst?.sessionModel ?? null, modelOverride: inst?.modelOverride ?? null, harnessGoverned: tabHasExtensions(t), contextTokens: resolveContextInputs(inst).tokens }
    }),
  )
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setTabModel = useSessionStore((s) => s.setTabModel)
  // Engine-only state source — null on plain conversations (absence of data).
  const engineStatus = useActiveEngineStatusFields()
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const [open, setOpen] = useState(false)
  // A switch the operator has asked for but not yet paid for. Held until they
  // confirm the re-write cost; null whenever no confirmation is pending.
  const [pendingSwitch, setPendingSwitch] = useState<{ modelId: string; estimate: ModelSwitchCostEstimate } | null>(null)
  // Trigger pointer state (handlers gated off while busy — a disabled
  // control does not respond to hover/pressed).
  const triggerState = useInteractiveState()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (Studio top-anchored strip).
  useViewportClamp(popoverRef, open)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const allModels = useModelStore((s) => s.models)
  const fetchModels = useModelStore((s) => s.fetchModels)
  const hasModels = allModels.length > 0
  const lastFetched = useModelStore((s) => s.lastFetched)

  // Busy-gating: on conversation tabs we use the tab-level status; on
  // engine tabs we use the active instance's engine status because
  // each instance can be in a different run-state and only the active
  // one gates the picker.
  // Busy-gating from the conversation's run status — the same signal for every
  // tab type (tab.status reflects the active conversation's run state).
  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'
  // `harnessGoverned` only influences the engine-default fallback + the
  // actual-model parenthetical below; it is data, not a read/write fork.
  const harnessGoverned = !!tab?.harnessGoverned

  useEffect(() => {
    if (!hasModels) fetchModels().catch((err) => rError('model-picker', 'fetch models failed', { error: String(err) }))
  }, [hasModels, fetchModels])

  useEffect(() => {
    if (open && Date.now() - lastFetched > 60_000) fetchModels().catch((err) => rError('model-picker', 'fetch models failed', { error: String(err) }))
  }, [open, lastFetched, fetchModels])

  useEffect(() => { setOpen(false); setPendingSwitch(null) }, [activeTabId])

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

  // Effective model + display label resolve from ONE source for every tab:
  // the active instance's override (carried on `tab.modelOverride` here). A
  // harness-governed conversation folds in `engineDefaultModel` as a sensible
  // default before falling back to the global `preferredModel` — that fold is
  // the only place `harnessGoverned` (data) participates, not a read fork.
  const fallbackModel = allowedModels[0] ?? { id: '', label: '' }
  const effectiveModel = tab?.modelOverride
    || (harnessGoverned ? engineDefaultModel : '')
    || preferredModel
    || fallbackModel.id

  const activeLabel = (() => {
    if (tab?.modelOverride) return resolveModelDisplayLabel(tab.modelOverride, allModels)
    if (harnessGoverned && engineDefaultModel) return resolveModelDisplayLabel(engineDefaultModel, allModels)
    if (preferredModel) return resolveModelDisplayLabel(preferredModel, allModels)
    // Echo the model the engine reports it is actually running (governed
    // conversations) or the tab's last session model — both live as data and
    // are simply absent for an ungoverned plain tab that hasn't run yet.
    if (engineStatus?.model) return resolveModelDisplayLabel(engineStatus.model, allModels)
    if (tab?.sessionModel) return resolveModelDisplayLabel(tab.sessionModel, allModels)
    return fallbackModel.label
  })()

  // Show the (actualLabel) parenthetical when the engine reports it is actually
  // using a different model than the user's selection. This is a pure DATA
  // signal (engineStatus.model) — null for a plain conversation, so the
  // parenthetical self-hides; no tab-type fork.
  const actualModel = engineStatus?.model
  const actualLabel = actualModel ? resolveModelDisplayLabel(actualModel, allModels) : null
  const modelDiffers = !!actualModel && actualLabel !== activeLabel

  const handleSelect = (modelId: string) => {
    // One write path for every tab: setTabModel writes the active instance's
    // modelOverride (the unified home for the per-conversation model). The old
    // setEngineModel did the identical thing and is gone.
    if (!activeTabId) return
    // Switching the model a conversation runs on cannot reuse the prompt cache
    // the previous model built — the cache is keyed per exact model, so the
    // whole conversation is re-sent as cache-creation input on the next turn.
    // Confirm first when that cost is real. estimateModelSwitchCost returns
    // null on a fresh or just-cleared conversation, which is exactly the case
    // where the switch is free and the operator should not be interrupted.
    const estimate = estimateModelSwitchCost(
      tab?.contextTokens ?? null,
      allModels.find((m) => m.id === modelId) ?? null,
      allModels.find((m) => m.id === effectiveModel) ?? null,
    )
    if (estimate && modelId !== effectiveModel) {
      rInfo('model-picker', 'confirming mid-conversation model switch', {
        tabId: activeTabId, from: effectiveModel, to: modelId,
        tokens: estimate.tokens, estimatedCostUsd: estimate.costUsd,
      })
      setPendingSwitch({ modelId, estimate })
      setOpen(false)
      return
    }
    setTabModel(activeTabId, modelId)
  }

  const confirmPendingSwitch = () => {
    if (!pendingSwitch || !activeTabId) return
    rInfo('model-picker', 'operator accepted the switch cost', {
      tabId: activeTabId, to: pendingSwitch.modelId,
      estimatedCostUsd: pendingSwitch.estimate.costUsd,
    })
    setTabModel(activeTabId, pendingSwitch.modelId)
    setPendingSwitch(null)
  }

  const cancelPendingSwitch = () => {
    rInfo('model-picker', 'operator declined the switch cost', {
      tabId: activeTabId, to: pendingSwitch?.modelId,
    })
    setPendingSwitch(null)
  }

  // D-011: when enterprise policy narrows the list to a single model there is
  // nothing to pick — render the model name as a static label instead of a
  // dropdown. (Without a policy the list is the full AVAILABLE_MODELS, so
  // this branch only fires under an active single-model enterprise policy.)
  if (allowedModels.length === 1) {
    return (
      <span
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5"
        style={{ color: colors.textTertiary }}
        title="Model is set by your organization"
      >
        {resolveModelDisplayLabel(allowedModels[0].id, allModels)}
      </span>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        disabled={isBusy}
        {...(isBusy ? {} : triggerState.handlers)}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 ion-focusable"
        style={{
          color: triggerState.hover && !isBusy ? colors.textPrimary : colors.textTertiary,
          background: isBusy ? 'transparent' : interactiveBg(colors, triggerState),
          opacity: isBusy ? 0.45 : 1,
          cursor: isBusy ? 'default' : 'pointer',
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

      {pendingSwitch && (
        <ConfirmDialog
          title="Switch model?"
          message={`${formatModelSwitchCost(pendingSwitch.estimate)}\n\nA prompt cache belongs to one model, so the new model cannot read the cache this conversation already built.`}
          confirmLabel="Switch anyway"
          cancelLabel="Stay on this model"
          initialFocus="cancel"
          onConfirm={confirmPendingSwitch}
          onCancel={cancelPendingSwitch}
        />
      )}
    </>
  )
}
