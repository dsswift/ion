import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { GeneralTab } from './settings/GeneralTab'
import { AppearanceTab } from './settings/AppearanceTab'
import { TerminalTab } from './settings/TerminalTab'

const TABS = ['General', 'Appearance', 'Terminal'] as const
type TabId = (typeof TABS)[number]

const TAB_CONTENT: Record<TabId, React.FC> = {
  General: GeneralTab,
  Appearance: AppearanceTab,
  Terminal: TerminalTab,
}

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] }

interface SettingsDialogProps {
  onClose: () => void
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [activeTab, setActiveTab] = useState<TabId>('General')

  // Escape key dismisses
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (!popoverLayer) return null

  const ActiveContent = TAB_CONTENT[activeTab]

  return createPortal(
    <motion.div
      data-clui-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <motion.div
        data-clui-ui
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={TRANSITION}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 440,
          maxHeight: 520,
          borderRadius: 24,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px 0',
          }}
        >
          <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
            Settings
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: colors.textTertiary,
              padding: 4,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: 'flex',
            gap: 0,
            padding: '12px 16px 0',
            borderBottom: `1px solid ${colors.containerBorder}`,
          }}
        >
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${activeTab === tab ? colors.accent : 'transparent'}`,
                cursor: 'pointer',
                padding: '6px 14px 10px',
                fontSize: 13,
                fontWeight: activeTab === tab ? 600 : 400,
                color: activeTab === tab ? colors.textPrimary : colors.textTertiary,
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <ActiveContent />
        </div>
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}
