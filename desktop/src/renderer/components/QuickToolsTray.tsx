import React, { useEffect, useRef, type ComponentType } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { zoomAnchorEdges } from '../viewport-zoom'
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
import { useColors } from '../theme'
import { useActiveQuickTools } from './composer/useActiveQuickTools'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rWarn } from '../rendererLogger'
import type { ProjectQuickTool } from '@ion/shared/project-studio-config'

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
  /**
   * A Project Quick Tool was chosen. The owner of the tray runs it, because a
   * first run asks the operator to trust the project's tools, and that dialog
   * must outlive this tray (which closes on any outside click).
   */
  onProjectTool: (tool: ProjectQuickTool) => void
}

function TrayGroupLabel({ text }: { text: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider font-medium" style={{ color: colors.textTertiary }}>
      {text}
    </div>
  )
}

function TrayToolRow({ name, icon, testId, onRun }: { name: string; icon: string; testId: string; onRun: () => void }): React.JSX.Element {
  const colors = useColors()
  const IconComp = ICON_MAP[icon] || Lightning
  return (
    <button
      data-testid={testId}
      onClick={onRun}
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
        {name}
      </span>
    </button>
  )
}

export function QuickToolsTray({ anchorRef, onClose, onProjectTool }: QuickToolsTrayProps) {
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  // One rule decides which tools apply; the composer's lightning button reads
  // the same hook, so the button never opens onto an empty tray.
  const { user: visibleTools, project: projectTools, projectTrusted } = useActiveQuickTools()
  const trayRef = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (Studio top-anchored strip).
  useViewportClamp(trayRef, true)

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
  const anchorEl = anchorRef.current
  const anchorRect = anchorEl ? zoomAnchorEdges(anchorEl.getBoundingClientRect()) : undefined
  const bottom = anchorRect ? anchorRect.fromBottom + 8 : 120
  // Grow away from the nearer window edge: an anchor in the left half (the
  // composer's control row) opens rightward from its left edge; one in the
  // right half opens leftward from its right edge.
  const anchorOnLeft = anchorRect ? anchorRect.left < anchorRect.viewport.width / 2 : false
  const horizontal = !anchorRect
    ? { right: 40 }
    : anchorOnLeft
      ? { left: anchorRect.left }
      : { right: anchorRect.fromRight }

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={trayRef}
        data-ion-ui
        initial={{ opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        style={{
          position: 'fixed',
          bottom,
          ...horizontal,
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
        {visibleTools.length === 0 && projectTools.length === 0 && (
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
        )}
        {projectTools.length > 0 && (
          <>
            <TrayGroupLabel text={projectTrusted ? 'Project' : 'Project (not yet trusted)'} />
            {projectTools.map((tool) => (
              <TrayToolRow
                key={`project:${tool.id}`}
                testId={`quick-tool-project-${tool.id}`}
                name={tool.name}
                icon={tool.icon}
                onRun={() => { onProjectTool(tool); onClose() }}
              />
            ))}
          </>
        )}
        {visibleTools.length > 0 && (
          <>
            {projectTools.length > 0 && <TrayGroupLabel text="Yours" />}
            {visibleTools.map((tool) => (
              <TrayToolRow
                key={tool.id}
                testId={`quick-tool-user-${tool.id}`}
                name={tool.name}
                icon={tool.icon}
                onRun={() => {
                  if (activeTabId) {
                    void useSessionStore.getState().runQuickTool(activeTabId, tool.id).catch((error) => {
                      rWarn('terminal', 'quick tool terminal launch failed', {
                        tab_id: activeTabId,
                        tool_id: tool.id,
                        error: String(error),
                      })
                    })
                  }
                  onClose()
                }}
              />
            ))}
          </>
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
              useSessionStore.getState().openSettings('quicktools')
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
