import { nextMsgId, playNotificationIfHidden } from '../session-store-helpers'
import { commitInstance } from '../conversation-instance'
import type { StoreSet, StoreGet, State } from '../session-store-types'

/**
 * Bash-execution actions for the send slice. Extracted from send-slice.ts to
 * keep that file under the 600-line cap — the bash cluster (local `!` command
 * start/complete plus the iOS-originated remote bash path) is a cohesive,
 * self-contained group: all three actions append user+tool message pairs to
 * the active conversation instance and manage the tab's bashExecuting /
 * bashResults state. Spread into the send slice by createSendSlice, so store
 * composition is unchanged.
 */
export function createSendBashSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
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
