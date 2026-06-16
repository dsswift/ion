import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Bell, X } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { ResourceViewer } from './ResourceViewer'
import { selectTrayResources } from './notifications-tray-filter'
import type { ResourceItem } from '../../shared/types-engine'

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function ResourceCard({
  item,
  isRead,
  colors,
  onOpen,
  onDelete,
}: {
  item: ResourceItem
  isRead: boolean
  colors: ReturnType<typeof useColors>
  onOpen: (data: { title: string; content: string }) => void
  onDelete: () => void
}) {
  const title = item.title || (item.metadata?.agentName as string) || item.kind || 'Notification'

  const handleClick = () => {
    onOpen({ title, content: item.content })
    window.ion?.markResourceRead?.(item.kind, item.id)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.confirm('Delete this notification?')) return
    onDelete()
    window.ion?.publishResourceDelete?.(item.kind, item.id)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left flex flex-col gap-1"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0' }}
    >
      <div className="flex items-center gap-2">
        {!isRead && (
          <span
            className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
            style={{ background: colors.accent }}
          />
        )}
        {isRead && <span className="flex-shrink-0 w-1.5 h-1.5" />}
        <span
          className="text-[12px] font-medium flex-1 min-w-0 truncate"
          style={{ color: colors.textPrimary }}
        >
          {title}
        </span>
        <span className="text-[10px] flex-shrink-0 rounded px-1" style={{ color: colors.textTertiary, background: colors.surfaceHover }}>
          {item.kind}
        </span>
        <span className="text-[11px] flex-shrink-0" style={{ color: colors.textTertiary }}>
          {formatTime(item.createdAt)}
        </span>
        <span
          role="button"
          onClick={handleDelete}
          className="flex-shrink-0 flex items-center justify-center w-4 h-4 rounded opacity-40 hover:opacity-100 transition-opacity"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          title="Delete notification"
        >
          <X size={11} weight="bold" />
        </span>
      </div>
      <p
        className="text-[11px] ml-3.5 line-clamp-2"
        style={{ color: colors.textSecondary, margin: 0, lineHeight: 1.4 }}
      >
        {item.content.slice(0, 120)}
      </p>
    </button>
  )
}

export function NotificationsPanel() {
  // Collect ALL resource kinds, not just one hardcoded kind. The notifications
  // panel shows any workspace-level resource the engine delivers, minus the
  // kinds the user has chosen to exclude (blocklist; empty by default).
  const allResources = useSessionStore((s) => s.resources)
  const readResourceIds = useSessionStore((s) => s.readResourceIds)
  const markResourceRead = useSessionStore((s) => s.markResourceRead)
  const deleteResource = useSessionStore((s) => s.deleteResource)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const excludedResourceKinds = usePreferencesStore((s) => s.excludedResourceKinds)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight?: number }>({ right: 0 })
  const [viewerData, setViewerData] = useState<{ title: string; content: string } | null>(null)

  // Flatten all resource kinds into the global tray list via the shared,
  // unit-tested selector: workspace-only items, minus the user's blocklist,
  // newest first. Conversation-scoped items are excluded here (they live in
  // the per-conversation attachments panel) and are never blocklist-filtered.
  const sorted = selectTrayResources(allResources, excludedResourceKinds)
  const unreadCount = sorted.filter((item) => !readResourceIds.has(item.id)).length

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gap = 6
    const margin = 8
    const right = window.innerWidth - rect.right
    if (isExpanded) {
      const top = rect.bottom + gap
      setPos({ top, right, maxHeight: Math.max(120, window.innerHeight - top - margin) })
      return
    }
    setPos({ bottom: window.innerHeight - rect.top + gap, right, maxHeight: undefined })
  }, [isExpanded])

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

  useEffect(() => {
    if (!open) return
    let raf = 0
    const tick = () => { updatePos(); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }, [open, isExpanded, updatePos])

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors relative"
        style={{ color: colors.textTertiary }}
        title="Notifications"
      >
        <Bell size={14} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 rounded-full flex items-center justify-center text-[9px] font-bold leading-none px-0.5"
            style={{ background: colors.accent, color: '#fff' }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-ion-ui
          initial={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            ...(pos.top != null ? { top: pos.top } : {}),
            ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
            right: pos.right,
            width: 300,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            ...(pos.maxHeight != null ? { maxHeight: pos.maxHeight, overflowY: 'auto' as const } : {}),
          }}
        >
          <div className="p-3 flex flex-col gap-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold" style={{ color: colors.textPrimary }}>
                Notifications
              </span>
              {unreadCount > 0 && (
                <span className="text-[11px]" style={{ color: colors.textTertiary }}>
                  {unreadCount} unread
                </span>
              )}
            </div>

            {sorted.length === 0 && (
              <p className="text-[12px] py-2 text-center" style={{ color: colors.textTertiary }}>
                No notifications yet
              </p>
            )}

            {sorted.map((item, i) => (
              <React.Fragment key={item.id}>
                {i > 0 && <div style={{ height: 1, background: colors.popoverBorder }} />}
                <ResourceCard
                  item={item}
                  isRead={readResourceIds.has(item.id)}
                  colors={colors}
                  onOpen={(data) => {
                    markResourceRead(item.id)
                    setViewerData(data)
                    setOpen(false)
                  }}
                  onDelete={() => deleteResource(item.kind, item.id)}
                />
              </React.Fragment>
            ))}
          </div>
        </motion.div>,
        popoverLayer,
      )}

      {/* ResourceViewer modal */}
      {viewerData && (
        <ResourceViewer
          title={viewerData.title}
          content={viewerData.content}
          onClose={() => setViewerData(null)}
        />
      )}
    </>
  )
}

/** Bell button with unread badge for use in the TabStrip. */
export { NotificationsPanel as NotificationsBell }
