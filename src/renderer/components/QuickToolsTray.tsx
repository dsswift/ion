import React, { useEffect, useRef, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { IconProps } from '@phosphor-icons/react'
import {
  Lightning,
  GitBranch,
  GitMerge,
  GitCommit,
  GitPullRequest,
  Terminal,
  Play,
  Rocket,
  ArrowsClockwise,
  Package,
  Hammer,
  Broom,
  Upload,
  Download,
  Database,
  Globe,
  Code,
  Gear,
  CheckCircle,
  Trash,
} from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useThemeStore, useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'

const ICON_MAP: Record<string, ComponentType<IconProps>> = {
  Lightning,
  GitBranch,
  GitMerge,
  GitCommit,
  GitPullRequest,
  Terminal,
  Play,
  Rocket,
  ArrowsClockwise,
  Package,
  Hammer,
  Broom,
  Upload,
  Download,
  Database,
  Globe,
  Code,
  Gear,
  CheckCircle,
  Trash,
}

interface QuickToolsTrayProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

export function QuickToolsTray({ anchorRef, onClose }: QuickToolsTrayProps) {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const quickTools = useThemeStore((s) => s.quickTools)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const activeWorkDir = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''
  )
  const trayRef = useRef<HTMLDivElement>(null)

  // Filter tools by directory scope
  const visibleTools = quickTools.filter((tool) => {
    if (!tool.directories || tool.directories.length === 0) return true
    return tool.directories.some(
      (dir) => activeWorkDir === dir || activeWorkDir.startsWith(dir + '/')
    )
  })

  // Click-outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        trayRef.current &&
        !trayRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, anchorRef])

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (!popoverLayer) return null

  // Position above the anchor button
  const anchorRect = anchorRef.current?.getBoundingClientRect()
  const bottom = anchorRect ? window.innerHeight - anchorRect.top + 8 : 120
  const right = anchorRect ? window.innerWidth - anchorRect.right : 40

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={trayRef}
        data-coda-ui
        initial={{ opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        style={{
          position: 'fixed',
          bottom,
          right,
          pointerEvents: 'auto',
          background: colors.popoverBg,
          border: `1px solid ${colors.popoverBorder}`,
          borderRadius: 14,
          boxShadow: colors.popoverShadow,
          padding: 6,
          minWidth: 180,
          maxWidth: 260,
          zIndex: 10000,
        }}
      >
        {visibleTools.length === 0 ? (
          <div
            style={{
              padding: '12px 10px',
              color: colors.textTertiary,
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            No tools available for this tab
          </div>
        ) : (
          visibleTools.map((tool) => {
            const IconComp = ICON_MAP[tool.icon] || Lightning
            return (
              <button
                key={tool.id}
                onClick={() => {
                  if (activeTabId) {
                    useSessionStore.getState().runQuickTool(activeTabId, tool.id)
                  }
                  onClose()
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 8,
                  background: 'transparent',
                  color: colors.textPrimary,
                  fontSize: 13,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconComp size={16} weight="regular" />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tool.name}
                </span>
              </button>
            )
          })
        )}
        {/* Footer: edit tools link */}
        <div
          style={{
            borderTop: `1px solid ${colors.popoverBorder}`,
            marginTop: 4,
            paddingTop: 4,
          }}
        >
          <button
            onClick={() => {
              useSessionStore.getState().openSettings()
              onClose()
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              borderRadius: 8,
              background: 'transparent',
              color: colors.textTertiary,
              fontSize: 12,
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = colors.surfaceHover
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Gear size={14} />
            Edit Tools...
          </button>
        </div>
      </motion.div>
    </AnimatePresence>,
    popoverLayer
  )
}
