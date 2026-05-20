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

/* ─── Model Picker (inline — tightly coupled to StatusBar) ─── */

export function ModelPicker() {
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      return t ? { status: t.status, sessionModel: t.sessionModel, modelOverride: t.modelOverride } : undefined
    }),
  )
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setTabModel = useSessionStore((s) => s.setTabModel)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const fetchModels = useModelStore((s) => s.fetchModels)
  const hasModels = useModelStore((s) => s.models.length > 0)
  const lastFetched = useModelStore((s) => s.lastFetched)

  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'

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

  const effectiveModel = tab?.modelOverride || preferredModel || AVAILABLE_MODELS[0].id

  const activeLabel = (() => {
    if (tab?.modelOverride) {
      return getModelDisplayLabel(tab.modelOverride)
    }
    if (preferredModel) {
      return getModelDisplayLabel(preferredModel)
    }
    if (tab?.sessionModel) {
      return getModelDisplayLabel(tab.sessionModel)
    }
    return AVAILABLE_MODELS[0].label
  })()

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
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <ModelPickerPopover
          popoverRef={popoverRef}
          selectedModelId={effectiveModel}
          onSelect={(modelId) => { if (activeTabId) setTabModel(activeTabId, modelId) }}
          onClose={() => setOpen(false)}
          position={pos}
        />,
        popoverLayer,
      )}
    </>
  )
}
