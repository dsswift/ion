import type { TabStatus, Attachment } from '../../../shared/types'
import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId, playNotificationIfHidden, cancelDoneGroupMove } from '../session-store-helpers'
import { activeInstance, commitInstance, effectivePermissionMode, effectiveThinkingEffort } from '../conversation-instance'
import { applyActiveGroupMove } from './event-slice-running-move'
import { parseSlash } from '../../../main/slash-parse'

export function createSendSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    /**
     * Move a tab to planning/in-progress on send, based on its AUTHORITATIVE
     * permission mode (effectivePermissionMode resolves instance-vs-parent so
     * engine tabs are handled correctly). Cancels any pending done-move first.
     * Shared by every send path (CLI sendMessage / submitRemotePrompt and engine
     * submitEnginePrompt) so group movement is consistent across tab types.
     *
     * The group-selection logic lives in `applyActiveGroupMove`
     * (event-slice-running-move.ts) so the SAME decision fires from the running
     * transition (`maybeScheduleRunningMove`) too — a tab that starts running via
     * any non-send path (resume, relaunch, reconnect, remote) re-evaluates its
     * group identically.
     */
    applySendAutoGroupMove: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return

      // Cancel any pending done-group move from a prior task_complete, so a fast
      // re-send keeps the tab in in-progress instead of being yanked to done.
      if (cancelDoneGroupMove(tabId)) {
        console.log(`[auto-move:send] cancelled pending done-move for tab=${tabId.slice(0, 8)}`)
      }

      applyActiveGroupMove(tabId, tab, get().conversationPanes, get, 'send')
    },

    /**
     * Unified interrupt for EVERY conversation tab — plain or extension-backed.
     * There is no engine-vs-plain abort fork: the three actions below are all
     * DATA-conditioned, never tab-type-conditioned.
     *   1. Always send the abort (engineBridge.sendAbort under the hood — the
     *      single wire path both the old engineAbort and stopTab reached).
     *   2. Reap the dispatched-agent subtree IFF this tab has running children
     *      (data: any agentStates entry with status 'running' on the active
     *      instance). A plain conversation that dispatched background agents has
     *      running children too, so this is keyed on the data, not the tab type.
     *   3. Cancel an in-flight user bash command IFF tab.bashExecId is set.
     * Plus the 5s force-recover fallback so the UI is always usable even if the
     * engine never confirms idle. Folds together the abort logic that used to
     * live separately in EngineView.handleAbort and ConversationView's interrupt.
     */
    interrupt: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      const inst = activeInstance(get().conversationPanes, tabId)
      const hasRunningChildren = (inst?.agentStates ?? []).some((a) => a.status === 'running')
      console.log(`[interrupt] tab=${tabId.slice(0, 8)} status=${tab.status} hasRunningChildren=${hasRunningChildren} bashExecId=${tab.bashExecId ?? 'none'}`)

      // 1. In-flight user bash takes precedence — cancel it and stop. (A bash
      //    command and an agent run are mutually exclusive on a tab.)
      if (tab.bashExecId) {
        console.log(`[interrupt] cancelling bash: execId=${tab.bashExecId}`)
        window.ion.cancelBash(tab.bashExecId)
        return
      }

      // 2. Always abort the run. sendAbort is safe when no run is active (it
      //    warns and returns), covering the case where the desktop's status is
      //    stale while the engine still has a live run.
      console.log(`[interrupt] aborting run: tab=${tabId}`)
      window.ion.engineAbort(tabId).catch(() => {})

      // 3. Reap descendant agents (external processes) that might outlive the
      //    parent run's cancellation cascade — only when there are running
      //    children to reap.
      if (hasRunningChildren) {
        console.log(`[interrupt] reaping agent subtree: tab=${tabId}`)
        window.ion.engineAbortAgent(tabId, '', true).catch(() => {})
      }

      // 4. 5s fallback: if the engine never confirms idle, force-recover the tab
      //    so the interrupt button always produces a usable UI within 5 seconds.
      setTimeout(() => {
        const cur = get().tabs.find((t) => t.id === tabId)
        if (cur && (cur.status === 'running' || cur.status === 'connecting')) {
          get().forceRecoverTab(
            tabId,
            'Engine did not respond to interrupt within 5s. Tab reset locally.',
          )
        }
      }, 5_000)
    },

    startBashCommand: (command, execId) => {
      const { activeTabId } = get()
      const toolMsgId = nextMsgId()
      const now = Date.now()
      // Scrollback lives on the active conversation instance now; append the
      // user-bash + tool messages there and set bash/title flags on the tab.
      set((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, activeTabId, (inst) => ({
          ...inst,
          messages: [
            ...inst.messages,
            { id: nextMsgId(), role: 'user' as const, content: `! ${command}`, userExecuted: true, timestamp: now },
            { id: toolMsgId, role: 'tool' as const, content: '', toolName: 'Bash', toolInput: JSON.stringify({ command }), toolStatus: 'running' as const, userExecuted: true, timestamp: now },
          ],
        }))
        const tabs = s.tabs.map((t) => {
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
          }
        })
        return { tabs, conversationPanes }
      })
      return { toolMsgId, tabId: activeTabId }
    },

    completeBashCommand: (tabId, toolMsgId, command, stdout, stderr, exitCode) => {
      const { activeTabId, isExpanded } = get()
      const outputParts: string[] = []
      if (stdout) outputParts.push(stdout.trimEnd())
      if (stderr) outputParts.push(`stderr: ${stderr.trimEnd()}`)
      if (exitCode !== null && exitCode !== 0) outputParts.push(`exit code: ${exitCode}`)
      // The tool message being completed lives on the active instance scrollback.
      set((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: inst.messages.map((m) =>
            m.id === toolMsgId
              ? { ...m, content: outputParts.join('\n'), toolStatus: 'completed' as const }
              : m
          ),
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            bashExecuting: false,
            bashExecId: null,
            hasUnread: (t.id !== activeTabId || !isExpanded) ? true : t.hasUnread,
            bashResults: [...t.bashResults, { command, stdout, stderr }],
          }
        })
        return { tabs, conversationPanes }
      })
      playNotificationIfHidden()
    },

    /**
     * Unified prompt submit for EVERY conversation tab — plain or
     * extension-backed. This is the single send path; `submitEnginePrompt` is
     * gone. There is no engine-vs-plain fork: the only difference is DATA — an
     * extension-backed tab resolves a non-empty `extensions` list from its
     * profile (which the main pipeline routes on and which starts the engine
     * session with those extensions), a plain tab resolves none. Everything
     * else — optimistic insert, status lifecycle, mid-turn steer, rewind
     * context, pinned prompt, plan-mode sync — runs identically for both.
     *
     * `opts` carries the optional fields the old two actions split between
     * positional args; all default to undefined.
     */
    submit: (tabId, text, opts = {}) => {
      const { tabs, staticInfo } = get()
      const { projectPath, extraAttachments, appendSystemPrompt, implementationPhase, imageAttachments, source, resolveSlash } = opts
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      const resolvedPath = projectPath || (tab.hasChosenDirectory ? tab.workingDirectory : (staticInfo?.homePath || tab.workingDirectory || '~'))

      // Snapshot the active instance BEFORE the set() below so the fork-context
      // priorMessages read reflects pre-send history and the model/planFilePath
      // reads are pre-mutation.
      const sendInst = activeInstance(get().conversationPanes, tabId)

      if (tab.status === 'connecting') {
        console.log(`[submit] blocked: tab=${tab.id.slice(0, 8)} status=connecting, dropping prompt len=${text.length}`)
        return
      }

      // Auto group movement (+ pending done-move cancel) — every tab moves
      // consistently. Reads the authoritative per-tab permission mode internally.
      get().applySendAutoGroupMove(tab.id)

      const isBusy = tab.status === 'running'
      const requestId = crypto.randomUUID()

      const msgAttachments: Attachment[] = [
        ...tab.attachments,
        ...(extraAttachments || []),
      ]

      let fullPrompt = text
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
        ? (text.length > 40 ? text.substring(0, 37) + '...' : text)
        : tab.title

      set((s) => {
        // Optimistic user message onto the active instance; pinned prompt for
        // every tab (the view renders it iff present — harmless for plain).
        const userMessage = {
          id: nextMsgId(),
          role: 'user' as const,
          content: text,
          attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
          timestamp: Date.now(),
        }
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: [...inst.messages, userMessage],
          // On a fresh (non-busy) send, clear the pending denial card.
          ...(isBusy ? {} : { permissionDenied: null }),
        }))
        const enginePinnedPrompt = new Map(s.enginePinnedPrompt)
        enginePinnedPrompt.set(tabId, text)
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          const withEffectiveBase = t.hasChosenDirectory
            ? t
            : {
                ...t,
                hasChosenDirectory: true,
                workingDirectory: resolvedPath,
              }
          if (isBusy && !implementationPhase) {
            return {
              ...withEffectiveBase,
              title,
              attachments: [],
              bashResults: [],
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
          }
        })
        return {
          scrollToBottomCounter: s.scrollToBottomCounter + 1,
          tabs,
          conversationPanes,
          enginePinnedPrompt,
        }
      })

      if (isBusy && !implementationPhase) {
        window.ion.steer(tabId, fullPrompt)
        return
      }

      const preferredModel = usePreferencesStore.getState().preferredModel

      let effectiveSystemPrompt = appendSystemPrompt || undefined
      if (tab.forkedFromSessionId && !tab.conversationId) {
        const priorMessages = (sendInst?.messages ?? [])
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
          console.log(`[submit] rewind context injected: tabId=${tabId.slice(0, 8)} priorMessages=${priorMessages.length} transcriptLen=${transcript.length}`)
        }
      }

      // Permission mode is read from the AUTHORITATIVE per-tab location
      // (effectivePermissionMode resolves instance-vs-parent), then synced to
      // the engine session before the prompt so plan/auto is consistent for
      // every tab type.
      const currentMode = effectivePermissionMode(tab, get().conversationPanes)
      // Slash-aware prompt_sync. A slash command is a "run this task" intent,
      // incompatible with plan mode — the main-process pipeline flips plan→auto
      // for it (prompt-pipeline-slash.ts:maybeFlipPlanToAutoForSlash). If we
      // re-asserted `plan` here for a slash prompt, that prompt_sync set_plan_mode
      // would RE-ARM plan mode on the same prompt the flip is trying to disarm,
      // and the two policies fight (the bug that ran /align in plan mode). So when
      // the outgoing text is a slash invocation we sync `auto` instead of `plan`,
      // removing the re-arm rather than racing it. `/clear` is excluded: it is a
      // checkpoint, not a task, and the pipeline never flips it — re-asserting the
      // real mode keeps clear from silently leaving plan mode.
      const isSlashPrompt = (() => {
        const parsed = parseSlash(text.trim())
        return parsed !== null && parsed.command !== 'clear'
      })()
      const syncMode = isSlashPrompt ? 'auto' : currentMode
      // Forward the instance's planFilePath on a plan-mode sync so the engine
      // restores plan-file continuity even before the prompt is dispatched (the
      // prompt below also carries it). Only meaningful when entering/asserting
      // plan mode; dropped on 'auto'.
      window.ion.setPermissionMode(tabId, syncMode, 'prompt_sync', syncMode === 'plan' ? (sendInst?.planFilePath || undefined) : undefined)

      let extensions: string[] | undefined
      if (tab.engineProfileId) {
        const profile = usePreferencesStore.getState().engineProfiles.find((p) => p.id === tab.engineProfileId)
        if (profile?.extensions?.length) {
          extensions = profile.extensions
        }
      }

      // Thinking effort: read from the active instance via the unified seam
      // (effectiveThinkingEffort), gated by the global thinkingEnabled toggle.
      const thinkingEnabled = usePreferencesStore.getState().thinkingEnabled
      const instEffort = effectiveThinkingEffort(tab, get().conversationPanes)
      const thinkingEffort = thinkingEnabled && instEffort && instEffort !== 'off' ? instEffort : undefined

      window.ion.prompt(tabId, requestId, {
        prompt: fullPrompt,
        projectPath: resolvedPath,
        sessionId: tab.conversationId || undefined,
        model: sendInst?.modelOverride || preferredModel || undefined,
        addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
        appendSystemPrompt: effectiveSystemPrompt,
        extensions,
        implementationPhase,
        imageAttachments,
        // Raw paths for main-process encoding (PDFs/images -> wire bytes).
        // Only user-typed submits carry these; remote bounces arrive with
        // imageAttachments already encoded and an empty tab.attachments.
        rawAttachments: (() => {
          // Plan attachments are marker-only by design -- never encoded.
          const encodable = msgAttachments.filter(
            (a): a is typeof a & { type: 'image' | 'file' } => a.type === 'image' || a.type === 'file',
          )
          return encodable.length > 0
            ? encodable.map((a) => ({ type: a.type, name: a.name, path: a.path }))
            : undefined
        })(),
        thinkingEffort,
        planFilePath: sendInst?.planFilePath || undefined,
        // Forward remote-source marker so the IPC.PROMPT handler skips the
        // redundant desktop_message_added echo — iOS already received the
        // canonical echo from tabs-prompt.ts and a second echo with a
        // different id would cause a duplicate user bubble.
        source,
        // Forward the engine-resolve-slash flag from REMOTE_ENGINE_PROMPT so
        // the pipeline short-circuits to submitAsPrompt instead of
        // re-dispatching the extension command (which corrupts the
        // command-await FIFO queue and causes a 5s timeout + lost prompt).
        resolveSlash,
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

    submitRemotePrompt: (tabId, prompt, imageAttachments, resolveSlash) => {
      const { tabs, staticInfo } = get()
      const preferredModel = usePreferencesStore.getState().preferredModel
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      if (tab.status === 'connecting') {
        console.log(`[submitRemotePrompt] blocked: tab=${tab.id.slice(0, 8)} status=connecting, dropping prompt len=${prompt.length}`)
        return
      }

      // Auto group movement (+ pending done-move cancel) — shared path; reads
      // the authoritative per-tab permission mode internally.
      get().applySendAutoGroupMove(tab.id)

      const resolvedPath = tab.hasChosenDirectory
        ? tab.workingDirectory
        : (staticInfo?.homePath || tab.workingDirectory || '~')

      const requestId = crypto.randomUUID()
      const isBusy = tab.status === 'running'

      // Per-conversation state lives on the active instance; snapshot it before
      // the set() so the prompt-call reads pre-send modelOverride/planFilePath.
      const remoteInst = activeInstance(get().conversationPanes, tabId)

      const needsTitle = tab.title === 'New Tab' || tab.title === 'Resumed Session'
      const title = needsTitle
        ? (prompt.length > 40 ? prompt.substring(0, 37) + '...' : prompt)
        : tab.title

      set((s) => {
        const userMessage = { id: nextMsgId(), role: 'user' as const, content: prompt, timestamp: Date.now(), source: 'remote' as const }
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: [...inst.messages, userMessage],
          // Clear the pending denial on a fresh (non-busy) remote send.
          ...(isBusy ? {} : { permissionDenied: null }),
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          if (isBusy) {
            return { ...t, title }
          }
          return {
            ...t,
            status: 'connecting' as TabStatus,
            activeRequestId: requestId,
            lastEventAt: Date.now(),
            currentActivity: 'Starting...',
            title,
          }
        })
        return {
          scrollToBottomCounter: s.scrollToBottomCounter + 1,
          tabs,
          conversationPanes,
        }
      })

      if (isBusy) {
        window.ion.steer(tabId, prompt)
        return
      }

      const currentMode = effectivePermissionMode(tab, get().conversationPanes)
      // Slash-aware prompt_sync — same reasoning as the local sendMessage path
      // above: a slash command (other than /clear) must not re-arm plan mode, so
      // we sync `auto` for it instead of re-asserting `plan`. This keeps an
      // iOS-originated slash command on the same plan→auto path as a desktop one.
      const isSlashPrompt = (() => {
        const parsed = parseSlash(prompt.trim())
        return parsed !== null && parsed.command !== 'clear'
      })()
      const syncMode = isSlashPrompt ? 'auto' : currentMode
      // Same plan-file-continuity sync as the local sendMessage path above.
      window.ion.setPermissionMode(tabId, syncMode, 'prompt_sync', syncMode === 'plan' ? (remoteInst?.planFilePath || undefined) : undefined)

      let remoteExtensions: string[] | undefined
      if (tab.engineProfileId) {
        const profile = usePreferencesStore.getState().engineProfiles.find((p) => p.id === tab.engineProfileId)
        if (profile?.extensions?.length) {
          remoteExtensions = profile.extensions
        }
      }

      window.ion.prompt(tabId, requestId, {
        prompt,
        projectPath: resolvedPath,
        sessionId: tab.conversationId || undefined,
        model: remoteInst?.modelOverride || preferredModel || undefined,
        addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
        source: 'remote',
        extensions: remoteExtensions,
        imageAttachments,
        planFilePath: remoteInst?.planFilePath || undefined,
        // When the iOS slash re-submit set this, instruct the engine to
        // resolve + expand the raw `/command args` text rather than sending
        // it to the model verbatim. Absent/false for ordinary remote prompts.
        resolveSlash: resolveSlash || undefined,
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

      set((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
          ...inst,
          messages: [
            ...inst.messages,
            { id: userMsgId, role: 'user' as const, content: `! ${command}`, userExecuted: true, timestamp: now, source: 'remote' as const },
            { id: toolMsgId, role: 'tool' as const, content: '', toolName: 'Bash', toolInput: JSON.stringify({ command }), toolStatus: 'running' as const, userExecuted: true, timestamp: now },
          ],
        }))
        const tabs = s.tabs.map((t) => {
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
          }
        })
        return { scrollToBottomCounter: s.scrollToBottomCounter + 1, tabs, conversationPanes }
      })

      window.ion.executeBash(execId, command, cwd).then((result) => {
        const outputParts: string[] = []
        if (result.stdout) outputParts.push(result.stdout.trimEnd())
        if (result.stderr) outputParts.push(`stderr: ${result.stderr.trimEnd()}`)
        if (result.exitCode !== null && result.exitCode !== 0) outputParts.push(`exit code: ${result.exitCode}`)

        set((s) => {
          const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
            ...inst,
            messages: inst.messages.map((m) =>
              m.id === toolMsgId
                ? { ...m, content: outputParts.join('\n') || '(no output)', toolStatus: 'completed' as const }
                : m
            ),
          }))
          const tabs = s.tabs.map((t) => {
            if (t.id !== tabId) return t
            return {
              ...t,
              bashExecuting: false,
              bashExecId: null,
              bashResults: [...t.bashResults, { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }],
            }
          })
          return { tabs, conversationPanes }
        })

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
        set((s) => {
          const conversationPanes = commitInstance(s.conversationPanes, tabId, (inst) => ({
            ...inst,
            messages: inst.messages.map((m) =>
              m.id === toolMsgId
                ? { ...m, content: 'IPC error: bash execution failed', toolStatus: 'completed' as const }
                : m
            ),
          }))
          const tabs = s.tabs.map((t) => {
            if (t.id !== tabId) return t
            return {
              ...t,
              bashExecuting: false,
              bashExecId: null,
            }
          })
          return { tabs, conversationPanes }
        })
      })
    },
  }
}
