import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  FileText, PencilSimple, FileArrowUp, Terminal, MagnifyingGlass, Globe,
  Robot, Question, Wrench, FolderOpen, Copy, Check, CaretRight, CaretDown,
  SpinnerGap, ArrowCounterClockwise, Square, Image, FileCode, File, ListChecks,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { PermissionCard } from './PermissionCard'
import { PermissionDeniedCard } from './PermissionDeniedCard'
import { PlanViewer } from './PlanViewer'
import { useColors, useThemeStore } from '../theme'
import { InlineEditDiff } from './InlineEditDiff'
import type { Message, Attachment } from '../../shared/types'

// ─── Constants ───

const INITIAL_RENDER_CAP = 100
const PAGE_SIZE = 100
const REMARK_PLUGINS = [remarkGfm] // Hoisted — prevents re-parse on every render

// ─── Helpers ───

/** Serialize conversation messages into compact text context, filtering out
 *  plan-mode artifacts. Used to prime a fresh session with prior context. */
function serializeConversation(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.toolName === 'ExitPlanMode' || msg.toolName === 'EnterPlanMode') continue
    if (msg.role === 'user') {
      lines.push(`User: ${msg.content}`)
    } else if (msg.role === 'assistant' && msg.content && !msg.toolName) {
      lines.push(`Assistant: ${msg.content}`)
    }
  }
  return lines.join('\n\n')
}

// ─── Types ───

type GroupedItem =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  | { kind: 'system'; message: Message }
  | { kind: 'tool-group'; messages: Message[] }

// ─── Helpers ───

const HIDDEN_MESSAGES = [
  'Plan mode is not active. Do not create plans or call ExitPlanMode. Implement the requested changes directly using Edit, Write, and Bash tools.',
]

function groupMessages(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = []
  let toolBuf: Message[] = []

  const flushTools = () => {
    if (toolBuf.length > 0) {
      result.push({ kind: 'tool-group', messages: [...toolBuf] })
      toolBuf = []
    }
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && HIDDEN_MESSAGES.includes(msg.content.trim())) continue
    if (msg.role === 'tool') {
      toolBuf.push(msg)
    } else {
      flushTools()
      if (msg.role === 'user') result.push({ kind: 'user', message: msg })
      else if (msg.role === 'assistant') result.push({ kind: 'assistant', message: msg })
      else result.push({ kind: 'system', message: msg })
    }
  }
  flushTools()
  return result
}

// ─── Main Component ───

export function ConversationView() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [renderOffset, setRenderOffset] = useState(0) // 0 = show from tail
  const isNearBottomRef = useRef(true)
  const prevTabIdRef = useRef(activeTabId)
  const colors = useColors()
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const isTallView = useSessionStore((s) => s.tallViewTabId === s.activeTabId)

  const tab = tabs.find((t) => t.id === activeTabId)

  // Reset render offset and scroll state when switching tabs
  useEffect(() => {
    if (activeTabId !== prevTabIdRef.current) {
      prevTabIdRef.current = activeTabId
      setRenderOffset(0)
      isNearBottomRef.current = true
    }
  }, [activeTabId])

  // Track whether user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // Auto-scroll when content changes and user is near bottom.
  const msgCount = tab?.messages.length ?? 0
  const lastMsg = tab?.messages[tab.messages.length - 1]
  const permissionQueueLen = tab?.permissionQueue?.length ?? 0
  const queuedCount = tab?.queuedPrompts?.length ?? 0
  const scrollTrigger = `${msgCount}:${lastMsg?.content?.length ?? 0}:${permissionQueueLen}:${queuedCount}`

  useEffect(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [scrollTrigger])

  // Group only the visible slice of messages
  const allMessages = tab?.messages ?? []
  const totalCount = allMessages.length
  const startIndex = Math.max(0, totalCount - INITIAL_RENDER_CAP - renderOffset * PAGE_SIZE)
  const visibleMessages = startIndex > 0 ? allMessages.slice(startIndex) : allMessages
  const hasOlder = startIndex > 0

  const grouped = useMemo(
    () => groupMessages(visibleMessages),
    [visibleMessages],
  )

  const hiddenCount = totalCount - visibleMessages.length

  const handleLoadOlder = useCallback(() => {
    setRenderOffset((o) => o + 1)
  }, [])

  if (!tab) return null

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const isDead = tab.status === 'dead'
  const isFailed = tab.status === 'failed'
  const showInterrupt = (isRunning || tab.bashExecuting) && tab.messages.some((m) => m.role === 'user')

  if (tab.messages.length === 0) {
    return <EmptyState />
  }

  // Messages from before initial render cap are "historical" — no motion
  const historicalThreshold = Math.max(0, totalCount - 20)

  const handleRetry = () => {
    const lastUserMsg = [...tab.messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) {
      sendMessage(lastUserMsg.content)
    }
  }

  return (
    <div
      data-coda-ui
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Scrollable messages area */}
      <div
        ref={scrollRef}
        className="overflow-y-auto overflow-x-hidden px-4 pt-2 conversation-selectable"
        style={{ maxHeight: isTallView ? 'calc(100vh - 260px)' : expandedUI ? 460 : 336, paddingBottom: 28 }}
        onScroll={handleScroll}
      >
        {/* Load older button */}
        {hasOlder && (
          <div className="flex justify-center py-2">
            <button
              onClick={handleLoadOlder}
              className="text-[11px] px-3 py-1 rounded-full transition-colors"
              style={{ color: colors.textTertiary, border: `1px solid ${colors.toolBorder}` }}
            >
              Load {Math.min(PAGE_SIZE, hiddenCount)} older messages ({hiddenCount} hidden)
            </button>
          </div>
        )}

        <div className="space-y-1 relative">
          {grouped.map((item, idx) => {
            const msgIndex = startIndex + idx
            const isHistorical = msgIndex < historicalThreshold

            switch (item.kind) {
              case 'user':
                return <UserMessage key={item.message.id} message={item.message} skipMotion={isHistorical} />
              case 'assistant':
                return <AssistantMessage key={item.message.id} message={item.message} skipMotion={isHistorical} />
              case 'tool-group':
                return <ToolGroup key={`tg-${item.messages[0].id}`} tools={item.messages} skipMotion={isHistorical} />
              case 'system':
                return <SystemMessage key={item.message.id} message={item.message} skipMotion={isHistorical} />
              default:
                return null
            }
          })}
        </div>

        {/* Permission card (shows first item from queue) */}
        <AnimatePresence>
          {tab.permissionQueue.length > 0 && (
            <PermissionCard
              tabId={tab.id}
              permission={tab.permissionQueue[0]}
              queueLength={tab.permissionQueue.length}
            />
          )}
        </AnimatePresence>

        {/* Permission denied fallback card */}
        <AnimatePresence>
          {tab.permissionDenied && (
            <PermissionDeniedCard
              tools={tab.permissionDenied.tools}
              sessionId={tab.claudeSessionId}
              projectPath={staticInfo?.projectPath || process.cwd()}
              messages={tab.messages}
              onDismiss={() => {
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
              }}
              onAnswer={(answer) => {
                // Dismiss the card
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
                // Resume session with the answer (no mode change, no context clear)
                sendMessage(answer)
              }}
              onApprove={(toolNames) => {
                // Approve the denied tools for future runs on this tab
                window.coda.approveDeniedTools(tab.id, toolNames)
                // Dismiss the card
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
                // Tell the agent to retry
                sendMessage('The denied tools have been approved. Please retry the operation.')
              }}
              onImplement={async (mode, clearContext) => {
                // Dismiss the card
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
                // Switch permission mode
                useSessionStore.getState().setPermissionMode(mode)

                let implementPrompt = 'Implement the plan'

                // Extract plan file path from messages for the plan attachment
                const msgs = [...tab.messages]
                const exitMsg = msgs.reverse().find(
                  (m) => m.toolName === 'ExitPlanMode' && m.toolInput
                )
                let planFilePath: string | null = null
                if (exitMsg?.toolInput) {
                  try {
                    const input = JSON.parse(exitMsg.toolInput)
                    planFilePath = (input.planFilePath as string) || null
                  } catch {}
                }

                // Read plan content for both paths
                let planContent: string | null = null
                if (planFilePath) {
                  try {
                    const result = await window.coda.readPlan(planFilePath)
                    planContent = result.content
                  } catch (err) {
                    console.warn('Failed to read plan file:', err)
                  }
                }

                // Both paths start a fresh Claude session to break out of
                // plan mode (known Claude Code bug: #32868, #32934).
                window.coda.resetTabSession(tab.id)

                if (clearContext) {
                  // Clear UI messages
                  useSessionStore.setState((s) => ({
                    tabs: s.tabs.map((t) =>
                      t.id === tab.id
                        ? {
                            ...t,
                            messages: [],
                            historicalSessionIds: [
                              ...t.historicalSessionIds,
                              ...(t.claudeSessionId && !t.historicalSessionIds.includes(t.claudeSessionId)
                                ? [t.claudeSessionId] : []),
                            ],
                            claudeSessionId: null,
                            lastResult: null,
                            currentActivity: '',
                            permissionQueue: [],
                            permissionDenied: null,
                            queuedPrompts: [],
                          }
                        : t
                    ),
                  }))

                  if (planContent) {
                    implementPrompt = `Implement the following plan:\n\n${planContent}`
                  }
                } else {
                  // Keep UI messages but start fresh Claude session.
                  // Conversation context goes via system prompt (invisible to user).
                  useSessionStore.setState((s) => ({
                    tabs: s.tabs.map((t) =>
                      t.id === tab.id
                        ? {
                            ...t,
                            historicalSessionIds: [
                              ...t.historicalSessionIds,
                              ...(t.claudeSessionId && !t.historicalSessionIds.includes(t.claudeSessionId)
                                ? [t.claudeSessionId] : []),
                            ],
                            claudeSessionId: null,
                          }
                        : t
                    ),
                  }))

                  if (planContent) {
                    implementPrompt = `Implement the following plan:\n\n${planContent}`
                  }
                }

                // Build plan attachment for the message
                const planAttachment = planFilePath ? [{
                  id: crypto.randomUUID(),
                  type: 'plan' as const,
                  name: planFilePath.split('/').pop() || 'plan.md',
                  path: planFilePath,
                }] : undefined

                // For non-clear-context, inject prior conversation as system
                // prompt context so the model has full history without plan-mode
                // patterns, but the user only sees "Implement the plan".
                const contextPrompt = !clearContext
                  ? serializeConversation(tab.messages)
                  : undefined
                const appendSys = contextPrompt
                  ? `The following is the conversation history from the planning session. Use it as context for implementation.\n\n<previous_conversation>\n${contextPrompt}\n</previous_conversation>`
                  : undefined

                sendMessage(implementPrompt, undefined, planAttachment, appendSys)
              }}
            />
          )}
        </AnimatePresence>

        {/* Queued prompts */}
        <AnimatePresence>
          {tab.queuedPrompts.map((prompt, i) => (
            <QueuedMessage key={`queued-${i}`} content={prompt} />
          ))}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>

      {/* Activity row — overlaps bottom of scroll area as a fade strip */}
      <div
        className="flex items-center justify-between px-4 relative"
        style={{
          height: 28,
          minHeight: 28,
          marginTop: -28,
          background: `linear-gradient(to bottom, transparent, ${colors.containerBg} 70%)`,
          zIndex: 2,
        }}
      >
        {/* Left: status indicator */}
        <div className="flex items-center gap-1.5 text-[11px] min-w-0">
          {isRunning && (
            <span className="flex items-center gap-1.5">
              <span className="flex gap-[3px]">
                <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: colors.statusRunning, animationDelay: '0ms' }} />
                <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: colors.statusRunning, animationDelay: '150ms' }} />
                <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: colors.statusRunning, animationDelay: '300ms' }} />
              </span>
              <span style={{ color: colors.textSecondary }}>{tab.currentActivity || 'Working...'}</span>
            </span>
          )}

          {isDead && (
            <span style={{ color: colors.statusError, fontSize: 11 }}>Session ended unexpectedly</span>
          )}

          {isFailed && (
            <span className="flex items-center gap-1.5">
              <span style={{ color: colors.statusError, fontSize: 11 }}>Failed</span>
              <button
                onClick={handleRetry}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors"
                style={{ color: colors.accent, fontSize: 11 }}
              >
                <ArrowCounterClockwise size={10} />
                Retry
              </button>
            </span>
          )}
        </div>

        {/* Right: interrupt button when running */}
        <div className="flex items-center flex-shrink-0">
          <AnimatePresence>
            {showInterrupt && (
              <InterruptButton tabId={tab.id} bashExecId={tab.bashExecId} />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

// ─── Empty State (directory picker before first message) ───

function EmptyState() {
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const colors = useColors()

  const handleChooseFolder = async () => {
    const dir = await window.coda.selectDirectory()
    if (dir) {
      setBaseDirectory(dir)
    }
  }

  return (
    <div
      className="flex flex-col items-center justify-center px-4 py-3 gap-1.5"
      style={{ minHeight: 80 }}
    >
      <button
        onClick={handleChooseFolder}
        className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg transition-colors"
        style={{
          color: colors.accent,
          background: colors.surfaceHover,
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <FolderOpen size={13} />
        Choose folder
      </button>
      <span className="text-[11px]" style={{ color: colors.textTertiary }}>
        Press <strong style={{ color: colors.textSecondary }}>⌥ + Space</strong> to show/hide this overlay
      </span>
    </div>
  )
}

// ─── Copy Button ───

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const colors = useColors()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0"
      style={{
        background: copied ? colors.statusCompleteBg : 'transparent',
        color: copied ? colors.statusComplete : colors.textTertiary,
        border: 'none',
      }}
      title="Copy response"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </motion.button>
  )
}

// ─── Interrupt Button ───

function InterruptButton({ tabId, bashExecId }: { tabId: string; bashExecId: string | null }) {
  const colors = useColors()

  const handleStop = () => {
    if (bashExecId) {
      window.coda.cancelBash(bashExecId)
    } else {
      window.coda.stopTab(tabId)
    }
  }

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={handleStop}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0 transition-colors"
      style={{
        background: 'transparent',
        color: colors.statusError,
        border: 'none',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = colors.statusErrorBg }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      title="Stop current task"
    >
      <Square size={9} weight="fill" />
      <span>Interrupt</span>
    </motion.button>
  )
}

// ─── Message Attachments ───

const FILE_ICONS: Record<string, React.ReactNode> = {
  'image/png': <Image size={12} />,
  'image/jpeg': <Image size={12} />,
  'image/gif': <Image size={12} />,
  'image/webp': <Image size={12} />,
  'image/svg+xml': <Image size={12} />,
  'text/plain': <FileText size={12} />,
  'text/markdown': <FileText size={12} />,
  'application/json': <FileCode size={12} />,
  'text/yaml': <FileCode size={12} />,
  'text/toml': <FileCode size={12} />,
}

const EDITABLE_EXTS = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml', '.toml', '.py', '.rs', '.go', '.css', '.html'])

function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const colors = useColors()
  const [planData, setPlanData] = useState<{ content: string; fileName: string } | null>(null)
  const { openFileInEditor } = useSessionStore.getState()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const workingDir = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.workingDirectory || '~'
  })

  const handleClick = async (a: Attachment) => {
    if (a.type === 'plan') {
      const result = await window.coda.readPlan(a.path)
      if (result.content && result.fileName) {
        setPlanData({ content: result.content, fileName: result.fileName })
      }
      return
    }
    // File attachment
    const ext = a.name.includes('.') ? '.' + a.name.split('.').pop()!.toLowerCase() : ''
    if (EDITABLE_EXTS.has(ext) && activeTabId) {
      openFileInEditor(workingDir, activeTabId, a.path)
    } else {
      const result = await window.coda.fsOpenNative(a.path)
      if (!result.ok) {
        console.warn('Failed to open file:', result.error)
      }
    }
  }

  return (
    <>
      <div className="flex gap-1 flex-wrap mt-1" style={{ maxWidth: '100%' }}>
        {attachments.map((a) => (
          <button
            key={a.id}
            onClick={() => handleClick(a)}
            className="flex items-center gap-1 cursor-pointer transition-opacity hover:opacity-80"
            style={{
              background: a.type === 'plan' ? 'rgba(34, 197, 94, 0.1)' : colors.surfacePrimary,
              border: `1px solid ${a.type === 'plan' ? 'rgba(34, 197, 94, 0.3)' : colors.surfaceSecondary}`,
              borderRadius: 10,
              padding: '2px 7px',
              maxWidth: 180,
            }}
          >
            <span className="flex-shrink-0" style={{ color: a.type === 'plan' ? 'rgba(34, 197, 94, 0.85)' : colors.textTertiary }}>
              {a.type === 'plan'
                ? <ListChecks size={12} />
                : (a.type !== 'plan' && FILE_ICONS[(a as any).mimeType || '']) || <File size={12} />}
            </span>
            <span
              className="text-[10px] font-medium truncate"
              style={{ color: a.type === 'plan' ? 'rgba(34, 197, 94, 0.85)' : colors.textSecondary }}
            >
              {a.name}
            </span>
          </button>
        ))}
      </div>
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

// ─── User Message ───

function UserMessage({ message, skipMotion }: { message: Message; skipMotion?: boolean }) {
  const colors = useColors()
  const isBashCmd = !!message.userExecuted

  // Strip attachment context lines that may be in historical messages
  const displayContent = message.content
    .replace(/^\[Attached (?:image|file): .+\]\n*/gm, '')
    .trim()

  const hasAttachments = message.attachments && message.attachments.length > 0

  const userMarkdownComponents = useMemo(() => ({
    table: ({ children }: any) => <TableScrollWrapper>{children}</TableScrollWrapper>,
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (href) window.coda.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
    img: ({ src, alt }: any) => <ImageCard src={src} alt={alt} colors={colors} />,
  }), [colors])

  const content = (
    <div
      className="text-[13px] leading-[1.5] px-3 py-1.5 max-w-[85%]"
      style={{
        background: colors.userBubble,
        color: colors.userBubbleText,
        border: isBashCmd ? '2px solid rgba(244, 114, 182, 0.5)' : `1px solid ${colors.userBubbleBorder}`,
        borderRadius: '14px 14px 4px 14px',
      }}
    >
      <div className="prose-cloud prose-cloud-user">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={userMarkdownComponents}>
          {displayContent}
        </Markdown>
      </div>
      {hasAttachments && <MessageAttachments attachments={message.attachments!} />}
    </div>
  )

  if (skipMotion) {
    return <div className="flex justify-end py-1.5">{content}</div>
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end py-1.5"
    >
      {content}
    </motion.div>
  )
}

// ─── Queued Message (waiting at bottom until processed) ───

function QueuedMessage({ content }: { content: string }) {
  const colors = useColors()

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end py-1.5"
    >
      <div
        className="text-[13px] leading-[1.5] px-3 py-1.5 max-w-[85%]"
        style={{
          background: colors.userBubble,
          color: colors.userBubbleText,
          border: `1px dashed ${colors.userBubbleBorder}`,
          borderRadius: '14px 14px 4px 14px',
          opacity: 0.6,
        }}
      >
        {content}
      </div>
    </motion.div>
  )
}

// ─── Table scroll wrapper — fade edges when horizontally scrollable ───

function TableScrollWrapper({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<string | undefined>(undefined)
  const prevFade = useRef<string | undefined>(undefined)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    let next: string | undefined
    if (scrollWidth <= clientWidth + 1) {
      next = undefined
    } else {
      const l = scrollLeft > 1
      const r = scrollLeft + clientWidth < scrollWidth - 1
      next = l && r
        ? 'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)'
        : l
          ? 'linear-gradient(to right, transparent, black 24px)'
          : r
            ? 'linear-gradient(to right, black calc(100% - 24px), transparent)'
            : undefined
    }
    if (next !== prevFade.current) {
      prevFade.current = next
      setFade(next)
    }
  }, [])

  useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const table = el.querySelector('table')
    if (table) ro.observe(table)
    return () => ro.disconnect()
  }, [update])

  return (
    <div
      ref={ref}
      onScroll={update}
      style={{
        overflowX: 'auto',
        scrollbarWidth: 'thin',
        maskImage: fade,
        WebkitMaskImage: fade,
      }}
    >
      <table>{children}</table>
    </div>
  )
}

// ─── Image card — graceful fallback when src returns 404 ───

function ImageCard({ src, alt, colors }: { src?: string; alt?: string; colors: ReturnType<typeof useColors> }) {
  const [failed, setFailed] = useState(false)
  // Reset failed state when src changes (e.g. during streaming)
  useEffect(() => { setFailed(false) }, [src])
  const label = alt || 'Image'
  const open = () => { if (src) window.coda.openExternal(String(src)) }

  if (failed || !src) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1.5 my-1 px-2.5 py-1.5 rounded-md text-[12px] cursor-pointer"
        style={{ background: colors.surfacePrimary, color: colors.accent, border: `1px solid ${colors.toolBorder}` }}
        onClick={open}
        title={src}
      >
        <Globe size={12} />
        Image unavailable{alt ? ` — ${alt}` : ''}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="block my-2 rounded-lg overflow-hidden border text-left cursor-pointer"
      style={{ borderColor: colors.toolBorder, background: colors.surfacePrimary }}
      onClick={open}
      title={src}
    >
      <img
        src={src}
        alt={label}
        className="block w-full max-h-[260px] object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {alt && (
        <div className="px-2 py-1 text-[11px]" style={{ color: colors.textTertiary }}>
          {alt}
        </div>
      )}
    </button>
  )
}

// ─── Assistant Message (memoized — only re-renders when content changes) ───

const AssistantMessage = React.memo(function AssistantMessage({
  message,
  skipMotion,
}: {
  message: Message
  skipMotion?: boolean
}) {
  const colors = useColors()

  const markdownComponents = useMemo(() => ({
    table: ({ children }: any) => <TableScrollWrapper>{children}</TableScrollWrapper>,
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (href) window.coda.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
    img: ({ src, alt }: any) => <ImageCard src={src} alt={alt} colors={colors} />,
  }), [colors])

  const inner = (
    <div className="group/msg relative">
      <div className="text-[13px] leading-[1.6] prose-cloud min-w-0 max-w-[92%]">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {message.content}
        </Markdown>
      </div>
      {/* Copy button — always in DOM, shown via CSS :hover (no React state needed).
          Absolute positioning so it never shifts the text layout. */}
      {message.content.trim() && (
        <div className="absolute bottom-0 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100">
          <CopyButton text={message.content} />
        </div>
      )}
    </div>
  )

  if (skipMotion) {
    return <div className="py-1">{inner}</div>
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="py-1"
    >
      {inner}
    </motion.div>
  )
}, (prev, next) => prev.message.content === next.message.content && prev.skipMotion === next.skipMotion)

// ─── Tool Group (collapsible timeline — Claude Code style) ───

/** Build a short description from tool name + input for the collapsed summary */
function toolSummary(tools: Message[]): string {
  if (tools.length === 0) return ''
  // Use first tool's context for summary
  const first = tools[0]
  const desc = getToolDescription(first.toolName || 'Tool', first.toolInput)
  if (tools.length === 1) return desc
  return `${desc} and ${tools.length - 1} more tool${tools.length > 2 ? 's' : ''}`
}

/** Short human-readable description from tool name + input */
function getToolDescription(name: string, input?: string): string {
  if (!input) return name

  // Try to extract a meaningful short description from the input JSON
  try {
    const parsed = JSON.parse(input)
    switch (name) {
      case 'Read': return `Read ${parsed.file_path || parsed.path || 'file'}`
      case 'Edit': return `Edit ${parsed.file_path || 'file'}`
      case 'Write': return `Write ${parsed.file_path || 'file'}`
      case 'Glob': return `Search files: ${parsed.pattern || ''}`
      case 'Grep': return `Search: ${parsed.pattern || ''}`
      case 'Bash': {
        const cmd = parsed.command || ''
        return cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd || 'Bash'
      }
      case 'WebSearch': return `Search: ${parsed.query || parsed.search_query || ''}`
      case 'WebFetch': return `Fetch: ${parsed.url || ''}`
      case 'Agent': return `Agent: ${(parsed.prompt || parsed.description || '').substring(0, 50)}`
      default: return name
    }
  } catch {
    // Input is not JSON or is partial — show truncated raw
    const trimmed = input.trim()
    if (trimmed.length > 60) return `${name}: ${trimmed.substring(0, 57)}...`
    return trimmed ? `${name}: ${trimmed}` : name
  }
}

function ToolRow({ tool, desc, isRunning, colors }: { tool: Message; desc: string; isRunning: boolean; colors: ReturnType<typeof useColors> }) {
  const expandToolResults = useThemeStore((s) => s.expandToolResults)
  const shouldAutoExpand = !!tool.autoExpandResult ||
    (expandToolResults && ['Edit', 'Write'].includes(tool.toolName || ''))
  const [showResult, setShowResult] = useState(!!tool.userExecuted || shouldAutoExpand)

  // Parse Edit/Write tool input for diff rendering
  const editDiff = useMemo(() => {
    if (tool.toolName !== 'Edit' || !tool.toolInput) return null
    try {
      const input = JSON.parse(tool.toolInput)
      if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
        return { oldString: input.old_string, newString: input.new_string }
      }
    } catch { /* fallback to raw content */ }
    return null
  }, [tool.toolName, tool.toolInput])

  const hasContent = !!tool.content || !!editDiff
  const lineCount = editDiff
    ? (editDiff.oldString ? editDiff.oldString.split('\n').length : 0) +
      (editDiff.newString ? editDiff.newString.split('\n').length : 0)
    : tool.content ? tool.content.split('\n').length : 0

  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="text-[12px] leading-[1.4] truncate"
          style={{ color: isRunning ? colors.textSecondary : colors.textTertiary }}
        >
          {desc}
        </span>
        {!isRunning && hasContent && (
          <span
            className="text-[10px] cursor-pointer select-none flex-shrink-0"
            style={{ color: colors.textMuted }}
            onClick={() => setShowResult(!showResult)}
          >
            +{lineCount} line{lineCount !== 1 ? 's' : ''}
          </span>
        )}
        {isRunning && (
          <span className="text-[10px]" style={{ color: colors.textMuted }}>
            running...
          </span>
        )}
      </span>
      {!isRunning && showResult && editDiff && (
        <InlineEditDiff oldString={editDiff.oldString} newString={editDiff.newString} />
      )}
      {!isRunning && showResult && !editDiff && tool.content && (
        <pre
          className="text-[11px] leading-[1.4] p-2 rounded overflow-auto whitespace-pre-wrap break-words"
          style={{
            margin: '4px 0 0 0',
            background: colors.surfaceHover,
            color: colors.textSecondary,
            maxHeight: shouldAutoExpand ? undefined : 200,
            border: `1px solid ${colors.toolBorder}`,
          }}
        >
          {tool.content}
        </pre>
      )}
    </>
  )
}

function ToolGroup({ tools, skipMotion }: { tools: Message[]; skipMotion?: boolean }) {
  const hasRunning = tools.some((t) => t.toolStatus === 'running')
  const hasUserExecuted = tools.some((t) => t.userExecuted)
  const expandToolResults = useThemeStore((s) => s.expandToolResults)
  const [expanded, setExpanded] = useState(hasUserExecuted)
  const prevHasRunning = useRef(hasRunning)
  const colors = useColors()

  // When tools finish running and the expand setting is on, keep the group expanded
  useEffect(() => {
    if (prevHasRunning.current && !hasRunning && expandToolResults) {
      setExpanded(true)
    }
    prevHasRunning.current = hasRunning
  }, [hasRunning, expandToolResults])

  const isOpen = expanded || hasRunning

  if (isOpen) {
    const inner = (
      <div className="py-1">
        {/* Collapse header — click to close */}
        {!hasRunning && (
          <div
            className="flex items-center gap-1 cursor-pointer mb-1.5"
            onClick={() => setExpanded(false)}
          >
            <CaretDown size={10} style={{ color: colors.textMuted }} />
            <span className="text-[11px]" style={{ color: colors.textMuted }}>
              Used {tools.length} tool{tools.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Timeline */}
        <div className="relative pl-6">
          {/* Vertical line */}
          <div
            className="absolute left-[10px] top-1 bottom-1 w-px"
            style={{ background: colors.timelineLine }}
          />

          <div className="space-y-1.5">
            {tools.map((tool) => {
              const isRunning = tool.toolStatus === 'running'
              const toolName = tool.toolName || 'Tool'
              const desc = getToolDescription(toolName, tool.toolInput)

              return (
                <div key={tool.id} className="relative">
                  {/* Timeline node */}
                  <div
                    className="absolute -left-6 top-[5px] w-[20px] flex items-center justify-center"
                  >
                    {isRunning
                      ? <SpinnerGap size={10} className="animate-spin" style={{ color: colors.statusRunning }} />
                      : <ToolIcon name={toolName} size={10} status={tool.toolStatus} />
                    }
                  </div>

                  {/* Tool row: description + optional line count, expandable content below */}
                  <div className="min-w-0">
                    <ToolRow tool={tool} desc={desc} isRunning={isRunning} colors={colors} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )

    if (skipMotion) return inner

    return (
      <motion.div
        key="expanded"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.15 }}
      >
        {inner}
      </motion.div>
    )
  }

  // Collapsed state — summary text + chevron, no container
  const summary = toolSummary(tools)

  const inner = (
    <div
      className="flex items-start gap-1 cursor-pointer py-[2px]"
      onClick={() => setExpanded(true)}
    >
      <CaretRight size={10} className="flex-shrink-0 mt-[2px]" style={{ color: colors.textTertiary }} />
      <span className="text-[11px] leading-[1.4]" style={{ color: colors.textTertiary }}>
        {summary}
      </span>
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      key="collapsed"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
}

// ─── System Message ───

function SystemMessage({ message, skipMotion }: { message: Message; skipMotion?: boolean }) {
  const isError = message.content.startsWith('Error:') || message.content.includes('unexpectedly')
  const colors = useColors()

  const inner = (
    <div
      className="text-[11px] leading-[1.5] px-2.5 py-1 rounded-lg inline-block whitespace-pre-wrap"
      style={{
        background: isError ? colors.statusErrorBg : colors.surfaceHover,
        color: isError ? colors.statusError : colors.textTertiary,
      }}
    >
      {message.content}
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
}

// ─── Tool Icon mapping ───

function ToolIcon({ name, size = 12, status }: { name: string; size?: number; status?: string }) {
  const colors = useColors()
  const ICONS: Record<string, React.ReactNode> = {
    Read: <FileText size={size} />,
    Edit: <PencilSimple size={size} />,
    Write: <FileArrowUp size={size} />,
    Bash: <Terminal size={size} />,
    Glob: <FolderOpen size={size} />,
    Grep: <MagnifyingGlass size={size} />,
    WebSearch: <Globe size={size} />,
    WebFetch: <Globe size={size} />,
    Agent: <Robot size={size} />,
    AskUserQuestion: <Question size={size} />,
  }

  const iconColor = status === 'error' ? colors.statusError
    : status === 'completed' ? colors.statusComplete
    : colors.textTertiary

  return (
    <span className="flex items-center" style={{ color: iconColor }}>
      {ICONS[name] || <Wrench size={size} />}
    </span>
  )
}
