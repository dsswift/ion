import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  FileText, PencilSimple, FolderOpen, ArrowCounterClockwise,
  Image, FileCode, File, ListChecks, GitFork,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { PermissionCard } from './PermissionCard'
import { PermissionDeniedCard } from './PermissionDeniedCard'
import { PlanViewer } from './PlanViewer'
import { useColors, useThemeStore } from '../theme'
import { useNavigableText, NavigableText, NavigableCode } from '../hooks/useNavigableLinks'
import { TodoListPanel } from './TodoListPanel'
import {
  groupMessages, type GroupedItem,
  ToolGroup, AssistantMessage, SystemMessage, InterruptButton, CopyButton,
  TableScrollWrapper, ImageCard,
} from './conversation'
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

// ─── Main Component ───

export function ConversationView() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const editQueuedMessage = useSessionStore((s) => s.editQueuedMessage)
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
  const scrollToBottomCounter = useSessionStore((s) => s.scrollToBottomCounter)

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

  // Force scroll to bottom when user sends a new message (even if scrolled up)
  useEffect(() => {
    if (scrollToBottomCounter > 0 && scrollRef.current) {
      isNearBottomRef.current = true
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [scrollToBottomCounter])

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
      data-ion-ui
      className="flex flex-col min-h-0 min-w-0 overflow-hidden"
      style={{ flex: 1 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Scroll area wrapper — relative so activity row can overlay */}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        {/* Scrollable messages area */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pt-2 conversation-selectable"
          style={{ paddingBottom: 28 }}
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

        <div className="space-y-1 relative min-w-0">
          {grouped.map((item, idx) => {
            const msgIndex = startIndex + idx
            const isHistorical = msgIndex < historicalThreshold

            switch (item.kind) {
              case 'user':
                return <UserMessage key={item.message.id} message={item.message} skipMotion={isHistorical} />
              case 'assistant':
                return <AssistantMessage key={item.message.id} message={item.message} skipMotion={isHistorical} actions={<MessageActions message={item.message} variant="assistant" />} />
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
              tabId={tab.id}
              sessionId={tab.conversationId}
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
                window.ion.approveDeniedTools(tab.id, toolNames)
                // Dismiss the card
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
                // Tell the agent to retry
                sendMessage('The denied tools have been approved. Please retry the operation.')
              }}
              onImplement={async (clearContext) => {
                // Dismiss the card
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
                // Switch to auto mode for implementation
                useSessionStore.getState().setPermissionMode('auto')

                // Auto-move tab to in-progress group if designated
                const { inProgressGroupId, tabGroupMode } = useThemeStore.getState()
                if (inProgressGroupId && tabGroupMode === 'manual' && tab.groupId !== inProgressGroupId) {
                  useSessionStore.getState().moveTabToGroup(tab.id, inProgressGroupId)
                }

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
                    const result = await window.ion.readPlan(planFilePath)
                    planContent = result.content
                  } catch (err) {
                    console.warn('Failed to read plan file:', err)
                  }
                }

                // Both paths start a fresh Claude session to break out of
                // plan mode (known Claude Code bug: #32868, #32934).
                window.ion.resetTabSession(tab.id)

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
                              ...(t.conversationId && !t.historicalSessionIds.includes(t.conversationId)
                                ? [t.conversationId] : []),
                            ],
                            conversationId: null,
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
                              ...(t.conversationId && !t.historicalSessionIds.includes(t.conversationId)
                                ? [t.conversationId] : []),
                            ],
                            conversationId: null,
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
            <QueuedMessage key={`queued-${i}`} content={prompt} onEdit={() => editQueuedMessage(tab.id)} />
          ))}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>

        {/* Activity row — absolutely positioned over bottom of scroll area */}
        <div
          className="flex items-center justify-between px-4"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 28,
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
              <InterruptButton onInterrupt={() => {
                if (tab.bashExecId) {
                  window.ion.cancelBash(tab.bashExecId)
                } else {
                  window.ion.stopTab(tab.id)
                }
              }} />
            )}
          </AnimatePresence>
        </div>
      </div>{/* end activity row */}
      </div>{/* end scroll + activity wrapper */}

      {/* Task list — pinned below scroll area */}
      <TodoListPanel messages={tab.messages} isRunning={isRunning} />
    </div>
  )
}

// ─── Empty State (directory picker before first message) ───

function EmptyState() {
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const colors = useColors()

  const handleChooseFolder = async () => {
    const dir = await window.ion.selectDirectory()
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

// ─── Message Actions (hover overlay for user & assistant messages) ───

function MessageActions({ message, variant }: { message: Message; variant: 'user' | 'assistant' }) {
  const colors = useColors()
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const rewindToMessage = useSessionStore((s) => s.rewindToMessage)
  const forkFromMessage = useSessionStore((s) => s.forkFromMessage)
  const isIdle = tab != null && tab.status !== 'running' && tab.status !== 'connecting'
  const [confirmRewind, setConfirmRewind] = useState(false)

  // Reset confirmation after timeout
  useEffect(() => {
    if (!confirmRewind) return
    const timer = setTimeout(() => setConfirmRewind(false), 2500)
    return () => clearTimeout(timer)
  }, [confirmRewind])

  const handleRewind = () => {
    if (!tab || !isIdle) return
    if (!confirmRewind) {
      setConfirmRewind(true)
      return
    }
    setConfirmRewind(false)
    rewindToMessage(tab.id, message.id)
  }

  return (
    <div className="flex items-center gap-0.5">
      <CopyButton text={message.content} />
      {variant === 'user' && (
        <>
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={handleRewind}
            disabled={!isIdle}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: confirmRewind ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
              color: confirmRewind ? '#ef4444' : colors.textTertiary,
              border: 'none',
            }}
            title="Rewind conversation to this message"
          >
            <ArrowCounterClockwise size={11} />
            <span>{confirmRewind ? 'Sure?' : 'Rewind'}</span>
          </motion.button>
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={() => tab && forkFromMessage(tab.id, message.id)}
            disabled={!tab}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: 'transparent',
              color: colors.textTertiary,
              border: 'none',
            }}
            title="Fork conversation from this message"
          >
            <GitFork size={11} />
            <span>Fork</span>
          </motion.button>
        </>
      )}
    </div>
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
      const result = await window.ion.readPlan(a.path)
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
      const result = await window.ion.fsOpenNative(a.path)
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
  const { onOpenFile, onOpenUrl } = useNavigableText()

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
          if (href) window.ion.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
    img: ({ src, alt }: any) => <ImageCard src={src} alt={alt} colors={colors} />,
    text: ({ children }: any) => <NavigableText onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, onOpenFile, onOpenUrl])

  const content = (
    <div className="group/msg relative inline-flex flex-col items-end max-w-[85%]">
      <div
        className="text-[13px] leading-[1.5] px-3 py-1.5"
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
      {displayContent.trim() && (
        <div className="absolute -bottom-5 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100">
          <MessageActions message={message} variant="user" />
        </div>
      )}
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

function QueuedMessage({ content, onEdit }: { content: string; onEdit?: () => void }) {
  const colors = useColors()

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end py-1.5 items-start gap-1"
    >
      {onEdit && (
        <button
          onClick={onEdit}
          className="flex items-center justify-center shrink-0 mt-1"
          style={{ opacity: 0.5, cursor: 'pointer', background: 'none', border: 'none', padding: 2 }}
          title="Edit queued message"
        >
          <PencilSimple size={14} color={colors.userBubbleText} />
        </button>
      )}
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
