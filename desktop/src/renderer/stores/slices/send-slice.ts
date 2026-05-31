import type { TabStatus, Attachment } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId, playNotificationIfHidden, cancelDoneGroupMove } from '../session-store-helpers'

export function createSendSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    startBashCommand: (command, execId) => {
      const { activeTabId } = get()
      const toolMsgId = nextMsgId()
      const now = Date.now()
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== activeTabId) return t
          const needsTitle = t.title === 'New Tab' || t.title === 'Resumed Session'
          const title = needsTitle
            ? (command.length > 40 ? command.substring(0, 37) + '...' : command)
            : t.title
          return {
            ...t,
            title,
            bashExecuting: true,
            bashExecId: execId,
            messages: [
              ...t.messages,
              { id: nextMsgId(), role: 'user' as const, content: `! ${command}`, userExecuted: true, timestamp: now },
              { id: toolMsgId, role: 'tool' as const, content: '', toolName: 'Bash', toolInput: JSON.stringify({ command }), toolStatus: 'running' as const, userExecuted: true, timestamp: now },
            ],
          }
        }),
      }))
      return { toolMsgId, tabId: activeTabId }
    },

    completeBashCommand: (tabId, toolMsgId, command, stdout, stderr, exitCode) => {
      const { activeTabId, isExpanded } = get()
      const outputParts: string[] = []
      if (stdout) outputParts.push(stdout.trimEnd())
      if (stderr) outputParts.push(`stderr: ${stderr.trimEnd()}`)
      if (exitCode !== null && exitCode !== 0) outputParts.push(`exit code: ${exitCode}`)
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            bashExecuting: false,
            bashExecId: null,
            hasUnread: (t.id !== activeTabId || !isExpanded) ? true : t.hasUnread,
            bashResults: [...t.bashResults, { command, stdout, stderr }],
            messages: t.messages.map((m) =>
              m.id === toolMsgId
                ? { ...m, content: outputParts.join('\n'), toolStatus: 'completed' as const }
                : m
            ),
          }
        }),
      }))
      playNotificationIfHidden()
    },

    sendMessage: (prompt, projectPath, extraAttachments, appendSystemPrompt, implementationPhase) => {
      const { activeTabId, tabs, staticInfo } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      const resolvedPath = projectPath || (tab?.hasChosenDirectory ? tab.workingDirectory : (staticInfo?.homePath || tab?.workingDirectory || '~'))
      if (!tab) return

      if (tab.status === 'connecting') return

      const effectiveMode = tab.permissionMode

      // Cancel any pending done-group move from a prior task_complete.
      // Without this, a fast re-send would move the tab to in-progress,
      // but the pending timer would fire and move it right back to done.
      const cancelled = cancelDoneGroupMove(tab.id)
      if (cancelled) {
        console.log(`[auto-move:send] cancelled pending done-move for tab=${tab.id.slice(0, 8)}`)
      }

      // Auto group movement: move tab based on effective permission mode
      const { autoGroupMovement, tabGroupMode, planningGroupId, inProgressGroupId } = usePreferencesStore.getState()
      console.log(`[auto-move:send] tab=${tab.id.slice(0, 8)} mode=${effectiveMode} autoGroup=${autoGroupMovement} tabGroupMode=${tabGroupMode} pinned=${tab.groupPinned} currentGroup=${tab.groupId ?? 'none'} inProgressGroup=${inProgressGroupId ?? 'none'} planningGroup=${planningGroupId ?? 'none'}`)
      if (autoGroupMovement && tabGroupMode === 'manual' && !tab.groupPinned) {
        if (effectiveMode === 'plan' && planningGroupId && tab.groupId !== planningGroupId) {
          console.log(`[auto-move:send] moving tab=${tab.id.slice(0, 8)} to planning group=${planningGroupId}`)
          get().moveTabToGroup(tab.id, planningGroupId)
        } else if (effectiveMode === 'auto' && inProgressGroupId && tab.groupId !== inProgressGroupId) {
          console.log(`[auto-move:send] moving tab=${tab.id.slice(0, 8)} to in-progress group=${inProgressGroupId}`)
          get().moveTabToGroup(tab.id, inProgressGroupId)
        }
      } else if (autoGroupMovement && tabGroupMode === 'manual' && tab.groupPinned) {
        const wouldMoveTo = effectiveMode === 'plan' ? planningGroupId : inProgressGroupId
        console.log(`[auto-move] suppressed: tab=${tab.id.slice(0, 8)} pinned=true currentGroup=${tab.groupId ?? 'none'} wouldMoveTo=${wouldMoveTo ?? 'none'}`)
      }

      const isBusy = tab.status === 'running'
      const requestId = crypto.randomUUID()

      const msgAttachments: Attachment[] = [
        ...tab.attachments,
        ...(extraAttachments || []),
      ]

      let fullPrompt = prompt
      if (tab.bashResults.length > 0) {
        const bashCtx = tab.bashResults.map((b) => {
          const parts = [`$ ${b.command}`]
          if (b.stdout) parts.push('```\n' + b.stdout.trimEnd() + '\n```')
          if (b.stderr) parts.push('stderr:\n```\n' + b.stderr.trimEnd() + '\n```')
          return parts.join('\n')
        }).join('\n\n')
        fullPrompt = bashCtx + '\n\n' + fullPrompt
      }
      if (msgAttachments.length > 0) {
        const attachmentCtx = msgAttachments
          .map((a) => `[Attached ${a.type}: ${a.path}]`)
          .join('\n')
        fullPrompt = `${attachmentCtx}\n\n${fullPrompt}`
      }

      const needsTitle = tab.title === 'New Tab' || tab.title === 'Resumed Session'
      const title = needsTitle
        ? (prompt.length > 40 ? prompt.substring(0, 37) + '...' : prompt)
        : tab.title

      set((s) => ({
        scrollToBottomCounter: s.scrollToBottomCounter + 1,
        tabs: s.tabs.map((t) => {
          if (t.id !== activeTabId) return t
          const withEffectiveBase = t.hasChosenDirectory
            ? t
            : {
                ...t,
                hasChosenDirectory: true,
                workingDirectory: resolvedPath,
              }
          if (isBusy) {
            return {
              ...withEffectiveBase,
              title,
              attachments: [],
              bashResults: [],
              messages: [
                ...withEffectiveBase.messages,
                {
                  id: nextMsgId(),
                  role: 'user' as const,
                  content: prompt,
                  attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
                  timestamp: Date.now(),
                },
              ],
            }
          }
          return {
            ...withEffectiveBase,
            status: 'connecting' as TabStatus,
            activeRequestId: requestId,
            lastEventAt: Date.now(),
            currentActivity: 'Starting...',
            title,
            attachments: [],
            bashResults: [],
            permissionDenied: null,
            messages: [
              ...withEffectiveBase.messages,
              {
                id: nextMsgId(),
                role: 'user' as const,
                content: prompt,
                attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
                timestamp: Date.now(),
              },
            ],
          }
        }),
      }))

      if (isBusy) {
        window.ion.steer(activeTabId, fullPrompt)
        return
      }

      const preferredModel = usePreferencesStore.getState().preferredModel

      let effectiveSystemPrompt = appendSystemPrompt || undefined
      if (tab.forkedFromSessionId && !tab.conversationId) {
        const priorMessages = tab.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .filter((m) => m.content.trim().length > 0)
        if (priorMessages.length > 0) {
          const transcript = priorMessages
            .map((m) => `[${m.role}]: ${m.content}`)
            .join('\n\n')
          const forkCtx = `This conversation was forked from a previous session. Here is the conversation history up to the fork point:\n\n<prior-conversation>\n${transcript}\n</prior-conversation>\n\nContinue from this point. The user's next message is the first message in this forked conversation.`
          effectiveSystemPrompt = effectiveSystemPrompt
            ? `${effectiveSystemPrompt}\n\n${forkCtx}`
            : forkCtx
        }
      }

      const currentMode = get().tabs.find(t => t.id === activeTabId)?.permissionMode ?? tab.permissionMode
      window.ion.setPermissionMode(activeTabId, currentMode, 'prompt_sync')

      let extensions: string[] | undefined
      if (tab.isEngine && tab.engineProfileId) {
        const profile = usePreferencesStore.getState().engineProfiles.find((p) => p.id === tab.engineProfileId)
        if (profile?.extensions?.length) {
          extensions = profile.extensions
        }
      }

      window.ion.prompt(activeTabId, requestId, {
        prompt: fullPrompt,
        projectPath: resolvedPath,
        sessionId: tab.conversationId || undefined,
        model: tab.modelOverride || preferredModel || undefined,
        addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
        appendSystemPrompt: effectiveSystemPrompt,
        extensions,
        implementationPhase,
        planFilePath: tab.planFilePath || undefined,
      }).catch((err: Error) => {
        get().handleError(activeTabId, {
          message: err.message,
          stderrTail: [],
          exitCode: null,
          elapsedMs: 0,
          toolCallCount: 0,
        })
      })
    },

    submitRemotePrompt: (tabId, prompt, imageAttachments) => {
      const { tabs, staticInfo } = get()
      const preferredModel = usePreferencesStore.getState().preferredModel
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      if (tab.status === 'connecting') return

      // Cancel any pending done-group move from a prior task_complete
      const cancelledRemote = cancelDoneGroupMove(tab.id)
      if (cancelledRemote) {
        console.log(`[auto-move:send] cancelled pending done-move for tab=${tab.id.slice(0, 8)} (remote)`)
      }

      // Auto group movement for remote prompts
      const { autoGroupMovement, tabGroupMode, planningGroupId, inProgressGroupId: ipGroupId } = usePreferencesStore.getState()
      if (autoGroupMovement && tabGroupMode === 'manual' && !tab.groupPinned) {
        if (tab.permissionMode === 'plan' && planningGroupId && tab.groupId !== planningGroupId) {
          get().moveTabToGroup(tab.id, planningGroupId)
        } else if (tab.permissionMode === 'auto' && ipGroupId && tab.groupId !== ipGroupId) {
          get().moveTabToGroup(tab.id, ipGroupId)
        }
      } else if (autoGroupMovement && tabGroupMode === 'manual' && tab.groupPinned) {
        const wouldMoveTo = tab.permissionMode === 'plan' ? planningGroupId : ipGroupId
        console.log(`[auto-move] suppressed: tab=${tab.id.slice(0, 8)} pinned=true currentGroup=${tab.groupId ?? 'none'} wouldMoveTo=${wouldMoveTo ?? 'none'}`)
      }

      const resolvedPath = tab.hasChosenDirectory
        ? tab.workingDirectory
        : (staticInfo?.homePath || tab.workingDirectory || '~')

      const requestId = crypto.randomUUID()
      const isBusy = tab.status === 'running'

      const needsTitle = tab.title === 'New Tab' || tab.title === 'Resumed Session'
      const title = needsTitle
        ? (prompt.length > 40 ? prompt.substring(0, 37) + '...' : prompt)
        : tab.title

      set((s) => ({
        scrollToBottomCounter: s.scrollToBottomCounter + 1,
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t
          if (isBusy) {
            return {
              ...t,
              title,
              messages: [
                ...t.messages,
                { id: nextMsgId(), role: 'user' as const, content: prompt, timestamp: Date.now(), source: 'remote' as const },
              ],
            }
          }
          return {
            ...t,
            status: 'connecting' as TabStatus,
            activeRequestId: requestId,
            lastEventAt: Date.now(),
            currentActivity: 'Starting...',
            title,
            permissionDenied: null,
            messages: [
              ...t.messages,
              { id: nextMsgId(), role: 'user' as const, content: prompt, timestamp: Date.now(), source: 'remote' as const },
            ],
          }
        }),
      }))

      if (isBusy) {
        window.ion.steer(tabId, prompt)
        return
      }

      const currentMode = get().tabs.find(t => t.id === tabId)?.permissionMode ?? tab.permissionMode
      window.ion.setPermissionMode(tabId, currentMode, 'prompt_sync')

      let remoteExtensions: string[] | undefined
      if (tab.isEngine && tab.engineProfileId) {
        const profile = usePreferencesStore.getState().engineProfiles.find((p) => p.id === tab.engineProfileId)
        if (profile?.extensions?.length) {
          remoteExtensions = profile.extensions
        }
      }

      window.ion.prompt(tabId, requestId, {
        prompt,
        projectPath: resolvedPath,
        sessionId: tab.conversationId || undefined,
        model: tab.modelOverride || preferredModel || undefined,
        addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
        source: 'remote',
        extensions: remoteExtensions,
        imageAttachments,
        planFilePath: tab.planFilePath || undefined,
      }).catch((err: Error) => {
        get().handleError(tabId, {
          message: err.message,
          stderrTail: [],
          exitCode: null,
          elapsedMs: 0,
          toolCallCount: 0,
        })
      })
    },

    submitRemoteBash: (tabId, command) => {
      const { tabs } = get()
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      if (tab.bashExecuting) return

      const cwd = tab.workingDirectory || '~'
      const toolMsgId = nextMsgId()
      const userMsgId = nextMsgId()
      const execId = crypto.randomUUID()
      const now = Date.now()

      set((s) => ({
        scrollToBottomCounter: s.scrollToBottomCounter + 1,
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId) return t
          const needsTitle = t.title === 'New Tab' || t.title === 'Resumed Session'
          const title = needsTitle
            ? (command.length > 40 ? command.substring(0, 37) + '...' : command)
            : t.title
          return {
            ...t,
            title,
            bashExecuting: true,
            bashExecId: execId,
            messages: [
              ...t.messages,
              { id: userMsgId, role: 'user' as const, content: `! ${command}`, userExecuted: true, timestamp: now, source: 'remote' as const },
              { id: toolMsgId, role: 'tool' as const, content: '', toolName: 'Bash', toolInput: JSON.stringify({ command }), toolStatus: 'running' as const, userExecuted: true, timestamp: now },
            ],
          }
        }),
      }))

      window.ion.executeBash(execId, command, cwd).then((result) => {
        const outputParts: string[] = []
        if (result.stdout) outputParts.push(result.stdout.trimEnd())
        if (result.stderr) outputParts.push(`stderr: ${result.stderr.trimEnd()}`)
        if (result.exitCode !== null && result.exitCode !== 0) outputParts.push(`exit code: ${result.exitCode}`)

        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId) return t
            return {
              ...t,
              bashExecuting: false,
              bashExecId: null,
              bashResults: [...t.bashResults, { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }],
              messages: t.messages.map((m) =>
                m.id === toolMsgId
                  ? { ...m, content: outputParts.join('\n') || '(no output)', toolStatus: 'completed' as const }
                  : m
              ),
            }
          }),
        }))

        window.ion.sendRemote({
          type: 'message_added',
          tabId,
          message: {
            id: `${execId}-result`,
            role: 'assistant',
            content: outputParts.join('\n') || '(no output)',
            timestamp: Date.now(),
            source: 'desktop',
          },
        })
      }).catch(() => {
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId) return t
            return {
              ...t,
              bashExecuting: false,
              bashExecId: null,
              messages: t.messages.map((m) =>
                m.id === toolMsgId
                  ? { ...m, content: 'IPC error: bash execution failed', toolStatus: 'completed' as const }
                  : m
              ),
            }
          }),
        }))
      })
    },
  }
}
