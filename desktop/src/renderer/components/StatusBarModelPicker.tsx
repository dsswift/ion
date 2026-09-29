import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { zoomAnchorEdges } from '../viewport-zoom'
import { createPortal } from 'react-dom'
import { CaretDown } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { resolveModelDisplayLabel } from '@ion/shared/model-identity'
import { useAllowedModels } from '../stores/use-allowed-models'
import { useModelStore, environmentModels } from '@ion/server/store/model-store'
import { useActiveTabEnvironmentId } from '../studio/connection/tab-environment'

import { ModelPickerPopover } from './ModelPickerPopover'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { selectedConversationModel } from '@ion/shared/conversation-model'
import { rError, rInfo } from '../rendererLogger'
import { useActiveEngineStatusFields } from './StatusBarEngineHelpers'
import { activeInstance } from '@ion/server/store/conversation-instance'
import {
  estimateModelSwitchCost,
  formatModelSwitchCost,
  formatModelSwitchReason,
  type ModelSwitchCostEstimate,
} from '@ion/shared/model-switch-cost'
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
 * - The default shown when the conversation has no pick of its own is
 *   `inst.resolvedModel`, which the conversation's server decides. Whether a
 *   harness governs the conversation is folded in there, not here.
 * - Shows the `(actualLabel)` parenthetical when the engine reports a different
 *   running model (`engineStatusFields.model`) than the current selection. That
 *   is pure data — null for a plain conversation, so the parenthetical
 *   self-hides.
 *
 * The popover, busy-state gating, and visual styling are identical for every
 * tab type.
 */
export function ModelPicker() {
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
      // contextTokens is the conversation's model-visible size — the exact
      // token count a model switch would re-send. resolveContextInputs is the
      // same helper the context indicator and status drawer use, so the
      // warning cannot quote a different number than the UI shows.
      //
      // lastMessageAt and idleSince locate the conversation's last real turn,
      // which is the turn that wrote the prompt cache. The switch estimate
      // needs it because the cheap stay-put rate only applies while that cache
      // is still readable; both are turn-boundary signals, so the later of the
      // two is the freshest evidence a request was actually sent. lastActivityAt
      // is deliberately NOT used — reconnects and renderer activity stamp it
      // without any provider request, which would report a dead cache as warm.
      return {
        status: t.status,
        sessionModel: inst?.sessionModel ?? null,
        modelOverride: inst?.modelOverride ?? null,
        resolvedModel: selectedConversationModel(inst),
        contextTokens: resolveContextInputs(inst).tokens,
        lastTurnAt: Math.max(t.lastMessageAt ?? 0, t.idleSince ?? 0) || null,
      }
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
  const [pendingSwitch, setPendingSwitch] = useState<{ modelId: string; providerId: string; estimate: ModelSwitchCostEstimate } | null>(null)
  // Trigger pointer state (handlers gated off while busy — a disabled
  // control does not respond to hover/pressed).
  const triggerState = useInteractiveState()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (Studio top-anchored strip).
  useViewportClamp(popoverRef, open)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  // The active conversation's Environment owns the catalog this picker
  // lists (ADR-033): a Grover tab picks from Grover's models.
  const environmentId = useActiveTabEnvironmentId()
  const allModels = useModelStore((s) => environmentModels(s, environmentId).models)
  const fetchModelsFor = useModelStore((s) => s.fetchModelsFor)
  const hasModels = allModels.length > 0
  const lastFetched = useModelStore((s) => environmentModels(s, environmentId).lastFetched)

  // Busy-gating: on conversation tabs we use the tab-level status; on
  // engine tabs we use the active instance's engine status because
  // each instance can be in a different run-state and only the active
  // one gates the picker.
  // Busy-gating from the conversation's run status — the same signal for every
  // tab type (tab.status reflects the active conversation's run state).
  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'

  useEffect(() => {
    if (!hasModels) fetchModelsFor(environmentId).catch((err) => rError('model-picker', 'fetch models failed', { environment_id: environmentId, error: String(err) }))
  }, [hasModels, fetchModelsFor, environmentId])

  useEffect(() => {
    if (open && Date.now() - lastFetched > 60_000) fetchModelsFor(environmentId).catch((err) => rError('model-picker', 'fetch models failed', { environment_id: environmentId, error: String(err) }))
  }, [open, lastFetched, fetchModelsFor, environmentId])

  useEffect(() => { setOpen(false); setPendingSwitch(null) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = zoomAnchorEdges(triggerRef.current.getBoundingClientRect())
    setPos({
      bottom: rect.fromBottom + 6,
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
  // the model the conversation's server resolved (`resolvedModel`, which
  // already folds in the override and the owner's defaults on that server).
  // This client's own default model is never consulted: it belongs to the
  // local server and would name the wrong model for a conversation elsewhere.
  const fallbackModel = allowedModels[0] ?? { id: '', label: '' }
  const effectiveModel = tab?.resolvedModel || fallbackModel.id

  const activeLabel = (() => {
    if (tab?.resolvedModel) return resolveModelDisplayLabel(tab.resolvedModel, allModels)
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

  const handleSelect = (modelId: string, providerId: string) => {
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
    //
    // The last-turn time decides how the stay-put side is priced: past the
    // model's published cache lifetime, staying put re-writes the prompt too,
    // and quoting the cache-read rate there would understate it enormously.
    const estimate = estimateModelSwitchCost(
      tab?.contextTokens ?? null,
      allModels.find((m) => m.id === modelId) ?? null,
      allModels.find((m) => m.id === effectiveModel) ?? null,
      { lastActivityAt: tab?.lastTurnAt ?? null },
    )
    if (estimate && modelId !== effectiveModel) {
      rInfo('model-picker', 'confirming mid-conversation model switch', {
        tabId: activeTabId, from: effectiveModel, to: modelId,
        tokens: estimate.tokens, estimatedCostUsd: estimate.costUsd,
        stayCostUsd: estimate.cachedCostUsd, cacheState: estimate.cacheState,
        idleSeconds: estimate.idleSeconds, cacheTtlSeconds: estimate.cacheTtlSeconds,
      })
      setPendingSwitch({ modelId, providerId, estimate })
      setOpen(false)
      return
    }
    setTabModel(activeTabId, modelId, providerId)
  }

  const confirmPendingSwitch = () => {
    if (!pendingSwitch || !activeTabId) return
    rInfo('model-picker', 'operator accepted the switch cost', {
      tabId: activeTabId, to: pendingSwitch.modelId,
      estimatedCostUsd: pendingSwitch.estimate.costUsd,
    })
    setTabModel(activeTabId, pendingSwitch.modelId, pendingSwitch.providerId)
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
          environmentId={environmentId}
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
          message={[formatModelSwitchCost(pendingSwitch.estimate), formatModelSwitchReason(pendingSwitch.estimate)].filter(Boolean).join('\n\n')}
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
