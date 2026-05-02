import type { TabStatus } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId, playNotificationIfHidden, totalInputTokens } from '../session-store-helpers'

export function createEventSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    handleNormalizedEvent: (tabId, event) => {
      set((s) => {
        const { activeTabId } = s
        const tabs = s.tabs.map((tab) => {
          if (tab.id !== tabId) return tab
          const updated = { ...tab, lastEventAt: Date.now() }

          switch (event.type) {
            case 'session_init':
              if (updated.conversationId && updated.conversationId !== event.sessionId
                  && !updated.historicalSessionIds.includes(updated.conversationId)) {
                updated.historicalSessionIds = [...updated.historicalSessionIds, updated.conversationId]
              }
              updated.conversationId = event.sessionId
              updated.lastKnownSessionId = event.sessionId
              updated.sessionModel = event.model
              updated.sessionTools = event.tools
              updated.sessionMcpServers = event.mcpServers
              updated.sessionSkills = event.skills
              updated.sessionVersion = event.version
              if (!event.isWarmup) {
                const isTerminal = updated.status === 'failed' || updated.status === 'dead' || updated.status === 'completed'
                if (isTerminal) break
                updated.status = 'running'
                updated.currentActivity = 'Thinking...'
                updated.permissionDenied = null
                if (updated.queuedPrompts.length > 0) {
                  const [nextPrompt, ...rest] = updated.queuedPrompts
                  updated.queuedPrompts = rest
                  updated.messages = [
                    ...updated.messages,
                    { id: nextMsgId(), role: 'user' as const, content: nextPrompt, timestamp: Date.now() },
                  ]
                }
              }
              break

            case 'stream_reset': {
              const lastMsgReset = updated.messages[updated.messages.length - 1]
              if (lastMsgReset?.role === 'assistant' && !lastMsgReset.toolName) {
                updated.messages = updated.messages.slice(0, -1)
              }
              break
            }

            case 'compacting':
              updated.currentActivity = event.active ? 'Compacting...' : 'Thinking...'
              break

            case 'tool_stalled':
              updated.currentActivity = `Running ${event.toolName} (${Math.round(event.elapsed)}s)...`
              break

            case 'text_chunk': {
              console.log(`[DIAG] text_chunk: tab=${tabId} len=${(event as any).text?.length} prev_msg_len=${updated.messages[updated.messages.length - 1]?.content?.length ?? 'N/A'}`)
              updated.currentActivity = 'Writing...'
              const lastMsg = updated.messages[updated.messages.length - 1]
              if (lastMsg?.role === 'assistant' && !lastMsg.toolName) {
                updated.messages = [
                  ...updated.messages.slice(0, -1),
                  { ...lastMsg, content: lastMsg.content + event.text },
                ]
              } else {
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() },
                ]
              }
              break
            }

            case 'tool_call':
              updated.currentActivity = `Running ${event.toolName}...`
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'tool',
                  content: '',
                  toolName: event.toolName,
                  toolId: event.toolId,
                  toolInput: '',
                  toolStatus: 'running',
                  timestamp: Date.now(),
                },
              ]
              break

            case 'tool_call_update': {
              const msgs = [...updated.messages]
              const lastTool = [...msgs].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
              if (lastTool) {
                lastTool.toolInput = (lastTool.toolInput || '') + event.partialInput
              }
              updated.messages = msgs
              break
            }

            case 'tool_call_complete': {
              const msgs2 = [...updated.messages]
              const runningTool = [...msgs2].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
              if (runningTool) {
                runningTool.toolStatus = 'completed'
              }
              updated.messages = msgs2
              break
            }

            case 'tool_result': {
              const msgs3 = [...updated.messages]
              const targetTool = [...msgs3].reverse().find((m) => m.role === 'tool' && m.toolId === event.toolId)
              if (targetTool) {
                targetTool.content = event.content
                if (event.isError && targetTool.toolName !== 'ExitPlanMode' && targetTool.toolName !== 'AskUserQuestion') {
                  targetTool.toolStatus = 'error'
                } else {
                  targetTool.toolStatus = 'completed'
                }
                if (usePreferencesStore.getState().expandToolResults && ['Write', 'Edit', 'NotebookEdit'].includes(targetTool.toolName || '')) {
                  targetTool.autoExpandResult = true
                }
                const FILE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit']
                if (!event.isError && FILE_WRITE_TOOLS.includes(targetTool.toolName || '')) {
                  updated.hasFileActivity = true
                }
              }
              updated.messages = msgs3
              break
            }

            case 'task_update': {
              if (event.message?.content) {
                const lastUserIdx = (() => {
                  for (let i = updated.messages.length - 1; i >= 0; i--) {
                    if (updated.messages[i].role === 'user') return i
                  }
                  return -1
                })()
                const hasStreamedText = updated.messages
                  .slice(lastUserIdx + 1)
                  .some((m) => m.role === 'assistant' && !m.toolName)

                if (!hasStreamedText) {
                  const textContent = event.message.content
                    .filter((b) => b.type === 'text' && b.text)
                    .map((b) => b.text!)
                    .join('')
                  if (textContent) {
                    updated.messages = [
                      ...updated.messages,
                      { id: nextMsgId(), role: 'assistant' as const, content: textContent, timestamp: Date.now() },
                    ]
                  }
                }

                for (const block of event.message.content) {
                  if (block.type === 'tool_use' && block.name) {
                    const exists = updated.messages.find(
                      (m) => m.role === 'tool' && m.toolName === block.name && !m.content
                    )
                    if (!exists) {
                      updated.messages = [
                        ...updated.messages,
                        {
                          id: nextMsgId(),
                          role: 'tool',
                          content: '',
                          toolName: block.name,
                          toolInput: JSON.stringify(block.input, null, 2),
                          toolStatus: 'completed',
                          timestamp: Date.now(),
                        },
                      ]
                    } else if (block.input) {
                      const completeInput = JSON.stringify(block.input, null, 2)
                      if (exists.toolInput !== completeInput) {
                        updated.messages = updated.messages.map((m) =>
                          m === exists ? { ...m, toolInput: completeInput } : m
                        )
                      }
                    }
                  }
                }
              }
              break
            }

            case 'usage': {
              const usageTokens = totalInputTokens(event.usage)
              if (usageTokens > 0) {
                updated.contextTokens = usageTokens
              }
              break
            }

            case 'task_complete':
              updated.status = 'completed'
              updated.activeRequestId = null
              updated.currentActivity = ''
              updated.permissionQueue = []
              if (event.sessionId) {
                updated.conversationId = event.sessionId
                updated.lastKnownSessionId = event.sessionId
              }
              updated.lastResult = {
                totalCostUsd: event.costUsd,
                durationMs: event.durationMs,
                numTurns: event.numTurns,
                usage: event.usage,
                sessionId: event.sessionId,
              }
              if (event.result) {
                const lastUserIdx2 = (() => {
                  for (let i = updated.messages.length - 1; i >= 0; i--) {
                    if (updated.messages[i].role === 'user') return i
                  }
                  return -1
                })()
                const hasAnyText = updated.messages
                  .slice(lastUserIdx2 + 1)
                  .some((m) => m.role === 'assistant' && !m.toolName)
                if (!hasAnyText) {
                  updated.messages = [
                    ...updated.messages,
                    { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp: Date.now() },
                  ]
                }
              }
              if (tabId !== activeTabId || !s.isExpanded) {
                updated.hasUnread = true
              }
              if (event.permissionDenials && event.permissionDenials.length > 0) {
                const hadPlanExit = event.permissionDenials.some((d) => d.toolName === 'ExitPlanMode')
                if (hadPlanExit) {
                  let exitPlanIsStale = false
                  if (updated.permissionMode === 'plan') {
                    for (let i = updated.messages.length - 1; i >= 0; i--) {
                      const m = updated.messages[i]
                      if (m.toolName === 'ExitPlanMode') break
                      if (m.role === 'user') { exitPlanIsStale = true; break }
                    }
                  }
                  if (updated.permissionMode !== 'plan' || exitPlanIsStale) {
                    const nonPlanDenials = event.permissionDenials.filter((d) => d.toolName !== 'ExitPlanMode')
                    updated.permissionDenied = nonPlanDenials.length > 0 ? { tools: nonPlanDenials } : null
                    if (updated.permissionMode !== 'plan') {
                      setTimeout(() => {
                        get().sendMessage('Plan mode is not active. Do not create plans or call ExitPlanMode. Implement the requested changes directly using Edit, Write, and Bash tools.')
                      }, 100)
                    }
                  } else {
                    updated.permissionDenied = { tools: event.permissionDenials }
                  }
                } else {
                  updated.permissionDenied = { tools: event.permissionDenials }
                }
              } else {
                updated.permissionDenied = null
              }
              playNotificationIfHidden()
              // Auto-move to done group on clean auto-mode completion
              // Guard: only move if tab was actually running (not a stale task_complete
              // from a killed session during resetTabSession → implement flow)
              if (tab.status === 'running' && updated.permissionMode === 'auto' && updated.permissionDenied === null) {
                const capturedTabId2 = tabId
                setTimeout(() => {
                  const { autoGroupMovement, tabGroupMode, doneGroupId } = usePreferencesStore.getState()
                  if (autoGroupMovement && tabGroupMode === 'manual' && doneGroupId) {
                    const currentTab = get().tabs.find(t => t.id === capturedTabId2)
                    if (currentTab && currentTab.groupId !== doneGroupId) {
                      get().moveTabToGroup(capturedTabId2, doneGroupId)
                    }
                  }
                }, 0)
              }
              if (
                !updated.customTitle &&
                usePreferencesStore.getState().aiGeneratedTitles
              ) {
                const firstUserMsg = updated.messages.find((m) => m.role === 'user')
                if (firstUserMsg) {
                  const capturedTabId = tabId
                  window.ion.generateTitle(firstUserMsg.content).then((title) => {
                    if (title) {
                      get().renameTab(capturedTabId, title)
                    }
                  }).catch(() => { /* keep truncated fallback */ })
                }
              }
              break

            case 'error':
              updated.status = 'failed'
              updated.activeRequestId = null
              updated.currentActivity = ''
              updated.permissionQueue = []
              updated.permissionDenied = null
              updated.messages = [
                ...updated.messages,
                { id: nextMsgId(), role: 'system', content: `Error: ${event.message}`, timestamp: Date.now() },
              ]
              break

            case 'session_dead':
              console.warn(`[Ion] session_dead: tab=${tabId} exitCode=${(event as any).exitCode}`)
              updated.status = 'dead'
              updated.activeRequestId = null
              updated.currentActivity = ''
              updated.permissionQueue = []
              updated.permissionDenied = null
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'system',
                  content: `Session ended unexpectedly (exit ${event.exitCode})`,
                  timestamp: Date.now(),
                },
              ]
              break

            case 'engine_plan_mode_changed' as any:
              if ((event as any).planFilePath) {
                updated.planFilePath = (event as any).planFilePath
              }
              break

            case 'permission_request': {
              const newReq: import('../../../shared/types').PermissionRequest = {
                questionId: event.questionId,
                toolTitle: event.toolName,
                toolDescription: event.toolDescription,
                toolInput: event.toolInput,
                options: event.options.map((o) => ({
                  optionId: o.id,
                  kind: o.kind,
                  label: o.label,
                })),
              }
              updated.permissionQueue = [...updated.permissionQueue, newReq]
              updated.currentActivity = `Waiting for permission: ${event.toolName}`
              break
            }

            case 'rate_limit':
              if (event.status !== 'allowed') {
                updated.messages = [
                  ...updated.messages,
                  {
                    id: nextMsgId(),
                    role: 'system',
                    content: `Rate limited (${event.rateLimitType}). Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`,
                    timestamp: Date.now(),
                  },
                ]
              }
              break
          }

          return updated
        })

        return { tabs }
      })
    },

    handleStatusChange: (tabId, newStatus) => {
      if (newStatus === 'dead') {
        console.warn(`[Ion] handleStatusChange: tab=${tabId} status=dead`)
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                status: newStatus as TabStatus,
                ...(newStatus === 'idle' || newStatus === 'failed' || newStatus === 'dead'
                  ? { activeRequestId: null, currentActivity: '', permissionQueue: [] as import('../../../shared/types').PermissionRequest[], permissionDenied: null }
                  : newStatus === 'completed'
                    ? { activeRequestId: null, currentActivity: '', permissionQueue: [] as import('../../../shared/types').PermissionRequest[] }
                    : {}),
              }
            : t
        ),
      }))
    },

    handleError: (tabId, error) => {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t

          const lastMsg = t.messages[t.messages.length - 1]
          const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')

          return {
            ...t,
            status: 'failed' as TabStatus,
            activeRequestId: null,
            currentActivity: '',
            permissionQueue: [],
            messages: alreadyHasError
              ? t.messages
              : [
                  ...t.messages,
                  {
                    id: nextMsgId(),
                    role: 'system' as const,
                    content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
                    timestamp: Date.now(),
                  },
                ],
          }
        }),
      }))
    },
  }
}
