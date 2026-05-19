import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Paperclip, FileText, Image, FileCode, File, ListChecks,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { PlanViewer } from './PlanViewer'

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

const ATTACHMENT_RE = /\[Attached (image|file|plan): ([^\]]+)\]/g

function parseAttachmentsFromMessages(
  messages: Array<{ role: string; content: string }>,
  planFilePath: string | null,
): ParsedAttachment[] {
  const seen = new Set<string>()
  const result: ParsedAttachment[] = []

  const add = (a: ParsedAttachment) => {
    if (seen.has(a.path)) return
    seen.add(a.path)
    result.push(a)
  }

  for (const msg of messages) {
    if (msg.role !== 'user') continue
    let m: RegExpExecArray | null
    ATTACHMENT_RE.lastIndex = 0
    while ((m = ATTACHMENT_RE.exec(msg.content)) !== null) {
      const kind = m[1] as 'image' | 'file' | 'plan'
      const path = m[2]
      const name = path.includes('/') ? path.split('/').pop()! : path
      add({ kind, name, path })
    }
  }

  // Also include the current in-progress plan if any
  if (planFilePath) {
    const name = planFilePath.includes('/') ? planFilePath.split('/').pop()! : planFilePath
    add({ kind: 'plan', name, path: planFilePath })
  }

  return result
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
  const [planData, setPlanData] = useState<{ content: string; fileName: string } | null>(null)

  const { messages, planFilePath, activeTabId, workingDir } = useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      return {
        messages: tab?.messages ?? [],
        planFilePath: tab?.planFilePath ?? null,
        activeTabId: s.activeTabId,
        workingDir: tab?.workingDirectory ?? '~',
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
    const result = await window.ion.readPlan(path)
    if (result.content && result.fileName) {
      setPlanData({ content: result.content, fileName: result.fileName })
    }
  }, [])

  const handleFileClick = useCallback(async (a: ParsedAttachment) => {
    const ext = extOf(a.name)
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

  const count = attachments.length

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
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'rgba(34, 197, 94, 0.7)',
                      padding: '4px 12px 2px',
                    }}
                  >
                    Plans
                  </div>
                  {plans.map((a) => (
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
                  <div
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: colors.textTertiary,
                      padding: '4px 12px 2px',
                    }}
                  >
                    Files
                  </div>
                  {files.map((a) => (
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
          onClose={() => setPlanData(null)}
        />
      )}
    </>
  )
}
