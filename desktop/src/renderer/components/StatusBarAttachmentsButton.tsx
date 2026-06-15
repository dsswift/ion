import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Paperclip, FileText, Image, FileCode, File, ListChecks, BookOpen, CaretRight,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { PlanViewer } from './PlanViewer'
import { ImageViewer } from './ImageViewer'
import { BriefingViewer } from './BriefingViewer'
import { parseAttachmentsFromMessages, type MsgLike } from './StatusBarAttachmentsParser'
import { activeInstance } from '../stores/conversation-instance'
import type { ResourceItem } from '../../shared/types-engine'

/* ─── Extension sets for icon picking ─── */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'])
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml'])
const EDITABLE_EXTS = new Set([
  '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml',
  '.toml', '.py', '.rs', '.go', '.css', '.html',
])

/* ─── Helpers ─── */

interface ParsedAttachment {
  kind: 'image' | 'file' | 'plan'
  name: string
  path: string
}

function extOf(name: string): string {
  return name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
}

function fileIcon(name: string, size: number) {
  const ext = extOf(name)
  if (IMAGE_EXTS.has(ext)) return <Image size={size} />
  if (CODE_EXTS.has(ext)) return <FileCode size={size} />
  if (TEXT_EXTS.has(ext)) return <FileText size={size} />
  return <File size={size} />
}

/* ─── Component ─── */

export function AttachmentsButton() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const [planData, setPlanData] = useState<{ content: string; fileName: string; filePath: string } | null>(null)
  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null)
  const [briefingData, setBriefingData] = useState<{ title: string; content: string } | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      return next
    })
  }, [])

  const { messages, planFilePath, activeTabId, workingDir, briefings } = useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      // Messages and plan state now live on the active `ConversationInstance`
      // for every tab type (normal tabs carry a single `main` instance), so
      // there is no longer a `tab.hasEngineExtension` fork — `activeInstance` resolves
      // the right instance uniformly.
      const inst = tab ? activeInstance(s.conversationPanes, tab.id) : null
      const msgs: MsgLike[] = (inst?.messages ?? []) as MsgLike[]
      // Conversation-scoped resources: filter global resources to items whose
      // conversationId matches the current tab's conversation.
      const tabConvId = tab?.conversationId ?? null
      const convBriefings: ResourceItem[] = tabConvId
        ? Object.values(s.resources).flat().filter((r) => r.conversationId === tabConvId)
        : []
      return {
        messages: msgs,
        // `instance.planFilePath` is only populated by the conversation
        // `plan_proposal` event path. Engine tabs surface their
        // current plan through the system divider message (parsed
        // inside `parseAttachmentsFromMessages`) or through a
        // `Write`/`Edit` tool call against `**/plans/*.md` (also
        // parsed inside). Either way, pass `instance.planFilePath`
        // through as a sentinel so explicit conversation-tab flows still work.
        planFilePath: inst?.planFilePath ?? null,
        activeTabId: s.activeTabId,
        workingDir: tab?.workingDirectory ?? '~',
        briefings: convBriefings,
      }
    }),
  )

  const attachments = useMemo(
    () => parseAttachmentsFromMessages(messages, planFilePath),
    [messages, planFilePath],
  )

  const plans = useMemo(() => attachments.filter((a) => a.kind === 'plan'), [attachments])
  const files = useMemo(() => attachments.filter((a) => a.kind !== 'plan'), [attachments])

  /* ─── Position popover above button ─── */

  const updatePos = useCallback(() => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left + rect.width / 2,
    })
  }, [])

  const toggle = useCallback(() => {
    if (!open) updatePos()
    setOpen((prev) => !prev)
  }, [open, updatePos])

  /* ─── Close on Escape or click outside ─── */

  useEffect(() => {
    if (!open) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        btnRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) return
      setOpen(false)
    }

    document.addEventListener('keydown', handleKey, true)
    document.addEventListener('mousedown', handleClick, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      document.removeEventListener('mousedown', handleClick, true)
    }
  }, [open])

  /* ─── Click handlers ─── */

  const handlePlanClick = useCallback(async (path: string) => {
    setOpen(false)
    const result = await window.ion.readPlan(path)
    if (result.content && result.fileName) {
      setPlanData({ content: result.content, fileName: result.fileName, filePath: path })
    }
  }, [])

  const handleFileClick = useCallback(async (a: ParsedAttachment) => {
    setOpen(false)
    const ext = extOf(a.name)
    if (IMAGE_EXTS.has(ext)) {
      setImagePreview({ path: a.path, name: a.name })
      return
    }
    if (EDITABLE_EXTS.has(ext) && activeTabId) {
      const { openFileInEditor } = useSessionStore.getState()
      openFileInEditor(workingDir, activeTabId, a.path)
    } else {
      const result = await window.ion.fsOpenNative(a.path)
      if (!result.ok) {
        console.warn('Failed to open file:', result.error)
      }
    }
  }, [activeTabId, workingDir])

  /* ─── Render ─── */

  const count = attachments.length + briefings.length

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center rounded-full px-1 py-0.5 transition-colors flex-shrink-0"
        style={{ color: open ? colors.accent : colors.textTertiary, cursor: 'pointer', position: 'relative' }}
        title={count > 0 ? `${count} attachment${count > 1 ? 's' : ''}` : 'No attachments'}
      >
        <Paperclip size={11} />
        {count > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -4,
              fontSize: 8,
              lineHeight: '12px',
              minWidth: 12,
              height: 12,
              borderRadius: 6,
              background: colors.accent,
              color: '#fff',
              textAlign: 'center',
              padding: '0 2px',
              fontWeight: 600,
            }}
          >
            {count}
          </span>
        )}
      </button>

      {/* Popover */}
      {popoverLayer && open && createPortal(
        <div
          ref={popoverRef}
          data-ion-ui
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            transform: 'translateX(-50%)',
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: `1px solid ${colors.popoverBorder}`,
            borderRadius: 6,
            boxShadow: colors.popoverShadow,
            padding: '6px 0',
            minWidth: 220,
            maxWidth: 320,
            maxHeight: 340,
            overflowY: 'auto',
          }}
        >
          {count === 0 ? (
            <div
              style={{
                padding: '12px 16px',
                fontSize: 11,
                color: colors.textTertiary,
                textAlign: 'center',
              }}
            >
              No attachments
            </div>
          ) : (
            <>
              {/* Plans section */}
              {plans.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => toggleSection('plans')}
                    className="flex items-center gap-1 w-full"
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'rgba(34, 197, 94, 0.7)',
                      padding: '4px 12px 2px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <CaretRight
                      size={8}
                      weight="bold"
                      style={{
                        flexShrink: 0,
                        transition: 'transform 0.15s',
                        transform: collapsedSections.has('plans') ? 'rotate(0deg)' : 'rotate(90deg)',
                      }}
                    />
                    <span>Plans ({plans.length})</span>
                  </button>
                  {!collapsedSections.has('plans') && plans.map((a) => (
                    <button
                      key={a.path}
                      onClick={() => handlePlanClick(a.path)}
                      className="flex items-center gap-2 w-full text-left transition-colors"
                      style={{
                        padding: '4px 12px',
                        fontSize: 11,
                        color: 'rgba(34, 197, 94, 0.85)',
                        cursor: 'pointer',
                        background: 'transparent',
                        border: 'none',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(34, 197, 94, 0.08)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <ListChecks size={13} style={{ flexShrink: 0 }} />
                      <span className="truncate">{a.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Separator */}
              {plans.length > 0 && files.length > 0 && (
                <div
                  style={{
                    height: 1,
                    background: colors.popoverBorder,
                    margin: '4px 10px',
                  }}
                />
              )}

              {/* Files section */}
              {files.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => toggleSection('files')}
                    className="flex items-center gap-1 w-full"
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: colors.textTertiary,
                      padding: '4px 12px 2px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <CaretRight
                      size={8}
                      weight="bold"
                      style={{
                        flexShrink: 0,
                        transition: 'transform 0.15s',
                        transform: collapsedSections.has('files') ? 'rotate(0deg)' : 'rotate(90deg)',
                      }}
                    />
                    <span>Files ({files.length})</span>
                  </button>
                  {!collapsedSections.has('files') && files.map((a) => (
                    <button
                      key={a.path}
                      onClick={() => handleFileClick(a)}
                      className="flex items-center gap-2 w-full text-left transition-colors"
                      style={{
                        padding: '4px 12px',
                        fontSize: 11,
                        color: colors.textSecondary,
                        cursor: 'pointer',
                        background: 'transparent',
                        border: 'none',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = colors.surfacePrimary
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <span style={{ flexShrink: 0, color: colors.textTertiary }}>
                        {fileIcon(a.name, 13)}
                      </span>
                      <span className="truncate">{a.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Separator before briefings */}
              {(plans.length > 0 || files.length > 0) && briefings.length > 0 && (
                <div
                  style={{
                    height: 1,
                    background: colors.popoverBorder,
                    margin: '4px 10px',
                  }}
                />
              )}

              {/* Briefings section - conversation-scoped resources */}
              {briefings.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => toggleSection('briefings')}
                    className="flex items-center gap-1 w-full"
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'rgba(139, 92, 246, 0.7)',
                      padding: '4px 12px 2px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <CaretRight
                      size={8}
                      weight="bold"
                      style={{
                        flexShrink: 0,
                        transition: 'transform 0.15s',
                        transform: collapsedSections.has('briefings') ? 'rotate(0deg)' : 'rotate(90deg)',
                      }}
                    />
                    <span>Briefings ({briefings.length})</span>
                  </button>
                  {!collapsedSections.has('briefings') && briefings.map((item) => {
                    const title = item.title || item.kind || 'Briefing'
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          setBriefingData({ title, content: item.content })
                          setOpen(false)
                        }}
                        className="flex items-center gap-2 w-full text-left transition-colors"
                        style={{
                          padding: '4px 12px',
                          fontSize: 11,
                          color: 'rgba(139, 92, 246, 0.85)',
                          cursor: 'pointer',
                          background: 'transparent',
                          border: 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(139, 92, 246, 0.08)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <BookOpen size={13} style={{ flexShrink: 0 }} />
                        <span className="truncate flex-1">{title}</span>
                        <span
                          style={{
                            fontSize: 9,
                            flexShrink: 0,
                            color: 'rgba(139, 92, 246, 0.5)',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {item.kind}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>,
        popoverLayer,
      )}

      {/* PlanViewer modal */}
      {planData && (
        <PlanViewer
          content={planData.content}
          fileName={planData.fileName}
          filePath={planData.filePath}
          onClose={() => setPlanData(null)}
        />
      )}

      {/* ImageViewer modal */}
      {imagePreview && (
        <ImageViewer
          filePath={imagePreview.path}
          fileName={imagePreview.name}
          onClose={() => setImagePreview(null)}
        />
      )}

      {/* BriefingViewer modal */}
      {briefingData && (
        <BriefingViewer
          title={briefingData.title}
          content={briefingData.content}
          onClose={() => setBriefingData(null)}
        />
      )}
    </>
  )
}
