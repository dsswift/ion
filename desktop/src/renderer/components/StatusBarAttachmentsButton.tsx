import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import {
  Paperclip, FileText, Image, FileCode, File, ListChecks, BookOpen, CaretRight,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { usePopoverLayer } from './PopoverLayer'
import { PlanViewer } from './PlanViewer'
import { ImageViewer } from './ImageViewer'
import { ResourceViewer } from './ResourceViewer'
import { parseAttachmentsFromMessages, type MsgLike } from './StatusBarAttachmentsParser'
import { AttachmentRow } from './StatusBarAttachmentsRow'
import { ChartsSection } from './StatusBarAttachmentsCharts'
import { activeInstance } from '../stores/conversation-instance'
import type { ResourceItem } from '../../shared/types-engine'
import { resourceIdentity } from '../../shared/resource-identity'
import { surfaceRouter, contentRouter } from '../lib/file-open-router'
import { rInfo, rWarn, rError } from '../rendererLogger'
import { CHART_RESOURCE_KIND, parseChartResourceItem } from './chart-attachment'

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

// Stable empty fallbacks: a `?? []` literal inside a store selector defeats
// snapshot memoization (new reference every call) — see the stability note
// on the selector below.
const EMPTY_MESSAGES: MsgLike[] = []
const EMPTY_RESOURCES: ResourceItem[] = []

/**
 * SELECTOR STABILITY IS LOAD-BEARING (React #185). This selector must return
 * only store-held references and scalars — never a freshly built array or
 * object. An earlier version built the conversation-scoped resource array
 * inside the selector (Object.values(...).flat().filter(...)): a fresh array
 * on every call is never Object.is-equal, so useShallow's memo never held,
 * getSnapshot was permanently unstable, and React threw #185 ("maximum
 * update depth exceeded") under streaming load — abandoning the StatusBar
 * subtree mid-render in BOTH windows. Derivation happens in useMemo in the
 * component. Exported so the stability test can pin this contract.
 */
export function selectAttachmentsData(s: {
  tabs: Array<{ id: string; conversationId: string | null; workingDirectory: string }>
  activeTabId: string
  conversationPanes: Parameters<typeof activeInstance>[0]
  resources: Record<string, ResourceItem[]>
}) {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  // Messages and plan state now live on the active `ConversationInstance`
  // for every tab type (normal tabs carry a single `main` instance), so
  // there is no longer a tab-type fork — `activeInstance` resolves the
  // right instance uniformly.
  const inst = tab ? activeInstance(s.conversationPanes, tab.id) : null
  return {
    messages: (inst?.messages ?? EMPTY_MESSAGES) as MsgLike[],
    // `instance.planFilePath` is only populated by the conversation
    // `plan_proposal` event path. Engine tabs surface their current plan
    // through the system divider message (parsed inside
    // `parseAttachmentsFromMessages`) or through a `Write`/`Edit` tool call
    // against `**/plans/*.md` (also parsed inside). Either way, pass
    // `instance.planFilePath` through as a sentinel so explicit
    // conversation-tab flows still work.
    planFilePath: inst?.planFilePath ?? null,
    activeTabId: s.activeTabId,
    workingDir: tab?.workingDirectory ?? '~',
    tabConvId: tab?.conversationId ?? null,
    resources: s.resources,
  }
}

export function AttachmentsButton() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const triggerState = useInteractiveState()
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  // Keep the portaled popover inside the window (Studio top-anchored strip).
  useViewportClamp(popoverRef, open)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const [planData, setPlanData] = useState<{ content: string; fileName: string; filePath: string } | null>(null)
  const closePlan = useCallback(() => setPlanData(null), [])
  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null)
  const [viewerData, setViewerData] = useState<{ title: string; content: string } | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      return next
    })
  }, [])

  const { messages, planFilePath, activeTabId, workingDir, tabConvId, resources } =
    useSessionStore(useShallow(selectAttachmentsData))

  // Conversation-scoped resources: filter global resources to items whose
  // conversationId matches the current tab's conversation. Derived OUTSIDE
  // the selector (see stability note above); recomputes only when the
  // resource map or the conversation actually changes.
  const convResources: ResourceItem[] = useMemo(
    () =>
      tabConvId
        ? Object.values(resources).flat().filter(
          (r) => r.conversationId === tabConvId && r.kind !== CHART_RESOURCE_KIND,
        )
        : EMPTY_RESOURCES,
    [resources, tabConvId],
  )

  // Charts get their own section rather than joining the generic Resources
  // list, because their row does something different: it navigates the
  // transcript to the chart's newest card instead of opening a text viewer.
  // One row per chart, never one per revision — the whole point of a named
  // chart is that it stays a single entry however often it is refreshed.
  const charts = useMemo(
    () =>
      (tabConvId
        ? Object.values(resources).flat().filter(
          (r) => r.conversationId === tabConvId && r.kind === CHART_RESOURCE_KIND,
        )
        : []
      )
        .map((item) => parseChartResourceItem(item))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    [resources, tabConvId],
  )

  // Evidence for the panel's own view of the data. Three rounds were spent
  // guessing which link was broken — main published, the store folded, the
  // parser accepted — because nothing reported what the PANEL held. These
  // counts distinguish "no chart items in the store", "items present but
  // scoped to another conversation", and "items scoped correctly but
  // rejected by the parser" from one line.
  useEffect(() => {
    const allCharts = Object.values(resources).flat().filter((r) => r.kind === CHART_RESOURCE_KIND)
    rInfo('attachments', 'chart section resolved', {
      tab_conv_id: tabConvId ?? '',
      chart_items_in_store: allCharts.length,
      chart_items_for_this_conv: allCharts.filter((r) => r.conversationId === tabConvId).length,
      chart_rows_rendered: charts.length,
      sample_conv_ids: [...new Set(allCharts.map((r) => r.conversationId ?? 'none'))].slice(0, 3),
    })
  }, [resources, tabConvId, charts])

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
    // Studio routes into a surface editor tab (markdown preview default) —
    // the shell's tab system replaces in-window popups; the overlay keeps
    // the floating PlanViewer.
    const router = surfaceRouter()
    if (router && activeTabId) {
      if (router.openPlan) router.openPlan(workingDir, activeTabId, path)
      else router.openTextFile(workingDir, activeTabId, path)
      return
    }
    const result = await window.ion.readPlan(path)
    if (result.content && result.fileName) {
      setPlanData({ content: result.content, fileName: result.fileName, filePath: path })
    }
  }, [activeTabId, workingDir])

  const handleFileClick = useCallback(async (a: ParsedAttachment) => {
    setOpen(false)
    const ext = extOf(a.name)
    if (IMAGE_EXTS.has(ext)) {
      // Studio: surface preview tab; overlay: floating ImageViewer.
      const router = surfaceRouter()
      if (router) router.openImage(a.path)
      else setImagePreview({ path: a.path, name: a.name })
      return
    }
    if (EDITABLE_EXTS.has(ext) && activeTabId) {
      const { openFileInEditor } = useSessionStore.getState()
      openFileInEditor(workingDir, activeTabId, a.path)
    } else {
      const result = await window.ion.fsOpenNative(a.path)
      if (!result.ok) {
        rWarn('attachments', 'failed to open file', { path: a.path, error: result.error })
      }
    }
  }, [activeTabId, workingDir])

  /* ─── Render ─── */

  const count = attachments.length + convResources.length + charts.length

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        {...triggerState.handlers}
        className="flex items-center rounded-full px-1 py-0.5 flex-shrink-0 ion-focusable"
        style={{
          color: open ? colors.accent : triggerState.hover ? colors.textPrimary : colors.textTertiary,
          background: interactiveBg(colors, triggerState),
          cursor: 'pointer',
          position: 'relative',
        }}
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
              color: colors.textOnAccent,
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
                    className="flex items-center gap-1 w-full ion-focusable"
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: colors.successFg,
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
                        transition: `transform ${transitions.fast}`,
                        transform: collapsedSections.has('plans') ? 'rotate(0deg)' : 'rotate(90deg)',
                      }}
                    />
                    <span>Plans ({plans.length})</span>
                  </button>
                  {!collapsedSections.has('plans') && plans.map((a) => (
                    <AttachmentRow
                      key={a.path}
                      colors={colors}
                      hoverBg={colors.permissionAllowBg}
                      color={colors.successFg}
                      onClick={() => { void handlePlanClick(a.path).catch((err) => rError('attachments', 'open plan failed', { path: a.path, error: String(err) })) }}
                    >
                      <ListChecks size={13} style={{ flexShrink: 0 }} />
                      <span className="truncate">{a.name}</span>
                    </AttachmentRow>
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
                    className="flex items-center gap-1 w-full ion-focusable"
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
                        transition: `transform ${transitions.fast}`,
                        transform: collapsedSections.has('files') ? 'rotate(0deg)' : 'rotate(90deg)',
                      }}
                    />
                    <span>Files ({files.length})</span>
                  </button>
                  {!collapsedSections.has('files') && files.map((a) => (
                    <AttachmentRow
                      key={a.path}
                      colors={colors}
                      hoverBg={colors.surfacePrimary}
                      color={colors.textSecondary}
                      onClick={() => { void handleFileClick(a).catch((err) => rError('attachments', 'open file failed', { path: a.path, error: String(err) })) }}
                    >
                      <span style={{ flexShrink: 0, color: colors.textTertiary }}>
                        {fileIcon(a.name, 13)}
                      </span>
                      <span className="truncate">{a.name}</span>
                    </AttachmentRow>
                  ))}
                </div>
              )}

              {/* Charts section — one row per named chart. Clicking navigates
                  to the chart's current card rather than opening a viewer. */}
              <ChartsSection
                charts={charts}
                colors={colors}
                showDivider={plans.length > 0 || files.length > 0}
                collapsed={collapsedSections.has('charts')}
                onToggle={() => toggleSection('charts')}
                onDismiss={() => setOpen(false)}
                activeTabId={activeTabId}
              />

              {/* Separator before conversation-scoped resources */}
              {(plans.length > 0 || files.length > 0 || charts.length > 0) && convResources.length > 0 && (
                <div
                  style={{
                    height: 1,
                    background: colors.popoverBorder,
                    margin: '4px 10px',
                  }}
                />
              )}

              {/* Resources section - conversation-scoped resources of any kind */}
              {convResources.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => toggleSection('resources')}
                    className="flex items-center gap-1 w-full ion-focusable"
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: colors.iconPurple,
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
                        transition: `transform ${transitions.fast}`,
                        transform: collapsedSections.has('resources') ? 'rotate(0deg)' : 'rotate(90deg)',
                      }}
                    />
                    <span>Resources ({convResources.length})</span>
                  </button>
                  {!collapsedSections.has('resources') && convResources.map((item) => {
                    const title = item.title || item.kind || 'Resource'
                    return (
                      <AttachmentRow
                        key={resourceIdentity(item)}
                        colors={colors}
                        hoverBg={colors.surfaceHover}
                        color={colors.iconPurple}
                        onClick={() => {
                          const router = contentRouter()
                          if (router?.openResource) router.openResource(item)
                          else setViewerData({ title, content: item.content })
                          setOpen(false)
                        }}
                      >
                        <BookOpen size={13} style={{ flexShrink: 0 }} />
                        <span className="truncate flex-1">{title}</span>
                        <span
                          style={{
                            fontSize: 9,
                            flexShrink: 0,
                            color: colors.iconPurple,
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {item.kind}
                        </span>
                      </AttachmentRow>
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
          onClose={closePlan}
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
