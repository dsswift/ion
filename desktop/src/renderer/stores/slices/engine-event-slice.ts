import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'

export function createEngineEventSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    handleEngineEvent: (key, event) => {
      if (!key.includes(':')) return

      const tabId = key.split(':')[0]
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, lastEventAt: Date.now() } : t)),
      }))
      switch (event.type) {
        case 'engine_agent_state': {
          const agents = event.agents || []
          const nonIdle = agents.filter((a: any) => a.status !== 'idle')
          console.log('[store] agent_state:', key, nonIdle.map((a: any) => `${a.name}:${a.status}:${a.lastWork?.substring(0,30)||'(empty)'}`))
          set((state) => {
            const agentStates = new Map(state.engineAgentStates)
            if (agents.length === 0) {
              const existing = agentStates.get(key)
              if (existing) {
                const historical = existing.filter((a) =>
                  a.status !== 'running' && a.metadata?.conversationId
                )
                if (historical.length > 0) {
                  agentStates.set(key, historical)
                } else {
                  agentStates.delete(key)
                }
              }
            } else {
              agentStates.set(key, agents)
            }
            return { engineAgentStates: agentStates }
          })
          break
        }
        case 'engine_status': {
          set((state) => {
            const statusFields = new Map(state.engineStatusFields)

            // Merge last-known context/cost into incoming status fields
            // so the footer doesn't reset to 0% when the engine emits a
            // status event without usage data.
            const prev = state.engineStatusFields.get(key)
            const merged = { ...event.fields }
            if (!merged.contextPercent) {
              const usage = state.engineUsage.get(key)
              if (usage && usage.percent > 0) {
                merged.contextPercent = usage.percent
              }
            }
            if (!merged.totalCostUsd && prev?.totalCostUsd) {
              merged.totalCostUsd = prev.totalCostUsd
            }
            statusFields.set(key, merged)
            const sessionId = event.fields?.sessionId
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const isIdle = event.fields?.state === 'idle'
            const isRunning = event.fields?.state === 'running'
            let engineConversationIds = state.engineConversationIds
            if (sessionId) {
              const existing = state.engineConversationIds.get(key) ?? []
              if (existing[existing.length - 1] !== sessionId) {
                engineConversationIds = new Map(state.engineConversationIds)
                engineConversationIds.set(key, [...existing, sessionId])
              }
            }
            const needsTabUpdate = isActive && (sessionId || isIdle || isRunning)
            if (needsTabUpdate) {
              const tabs = state.tabs.map((t) => {
                if (t.id !== tabId) return t
                const updates: Partial<typeof t> = {}
                if (sessionId && t.conversationId !== sessionId) {
                  updates.conversationId = sessionId
                  updates.lastKnownSessionId = sessionId
                }
                if (isRunning && t.status !== 'running') {
                  updates.status = 'running' as const
                }
                if (isIdle && t.status !== 'idle') {
                  updates.status = 'idle' as const
                }
                return Object.keys(updates).length > 0 ? { ...t, ...updates } : t
              })
              return { engineStatusFields: statusFields, engineConversationIds, tabs }
            }
            return { engineStatusFields: statusFields, engineConversationIds }
          })
          break
        }
        case 'engine_working_message': {
          set((state) => {
            const workingMessages = new Map(state.engineWorkingMessages)
            workingMessages.set(key, event.message)
            return { engineWorkingMessages: workingMessages }
          })
          break
        }
        case 'engine_notify': {
          set((state) => {
            const notifications = new Map(state.engineNotifications)
            const keyNotifications = [...(notifications.get(key) || [])]
            keyNotifications.push({ id: nextMsgId(), message: event.message, level: event.level, timestamp: Date.now() })
            notifications.set(key, keyNotifications)
            return { engineNotifications: notifications }
          })
          break
        }
        case 'engine_harness_message': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({
              id: nextMsgId(),
              role: 'harness' as const,
              content: event.message,
              timestamp: Date.now(),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_dialog': {
          set((state) => {
            const dialogs = new Map(state.engineDialogs)
            dialogs.set(key, { dialogId: event.dialogId, method: event.method, title: event.title, options: event.options, defaultValue: event.defaultValue })
            return { engineDialogs: dialogs }
          })
          break
        }
        case 'engine_text_delta': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, content: last.content + event.text }
            } else {
              msgs.push({ id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() })
            }
            messages.set(key, msgs)
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const tabs = isActive ? state.tabs.map((t) => t.id === tabId ? { ...t, status: 'running' as const } : t) : state.tabs
            return { engineMessages: messages, tabs }
          })
          break
        }
        case 'engine_message_end': {
          set((state) => {
            const usage = new Map(state.engineUsage)
            if (event.usage) {
              usage.set(key, {
                percent: event.usage.contextPercent,
                tokens: event.usage.inputTokens,
                cost: event.usage.cost,
              })
            }
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const tabs = isActive ? state.tabs.map((t) => {
              if (t.id !== tabId) return t
              return {
                ...t,
                status: 'idle' as const,
                ...(event.usage ? { contextTokens: event.usage.inputTokens, contextPercent: event.usage.contextPercent } : {}),
              }
            }) : state.tabs
            return { engineUsage: usage, tabs }
          })
          break
        }
        case 'engine_tool_start': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({
              id: event.toolId,
              role: 'tool' as const,
              content: '',
              toolName: event.toolName,
              toolId: event.toolId,
              toolStatus: 'running' as const,
              timestamp: Date.now(),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_tool_end': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = (messages.get(key) || []).map((m) => {
              if (m.toolId !== event.toolId) return m
              return { ...m, content: event.result || '', toolStatus: (event.isError ? 'error' : 'completed') as 'error' | 'completed' }
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
        case 'engine_dead': {
          console.warn(`[Ion] handleEngineEvent engine_dead: key=${key} tabId=${tabId} exitCode=${event.exitCode}`)
          if (event.exitCode === 0 || event.exitCode === null || event.exitCode === undefined) {
            break
          }
          set((state) => {
            const pane = state.enginePanes.get(tabId)
            const instanceId = key.split(':')[1]
            const otherInstances = pane?.instances.filter((i) => i.id !== instanceId) || []
            if (otherInstances.length === 0) {
              const tabs = state.tabs.map((t) => t.id === tabId ? { ...t, status: 'dead' as const } : t)
              return { tabs }
            }
            return {}
          })
          break
        }
        case 'engine_error': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({ id: nextMsgId(), role: 'system' as const, content: `Error: ${event.message}`, timestamp: Date.now() })
            messages.set(key, msgs)
            const pane = state.enginePanes.get(tabId)
            const isActive = !pane || pane.activeInstanceId === key.split(':')[1]
            const tabs = isActive
              ? state.tabs.map((t) => t.id === tabId ? { ...t, status: 'idle' as const } : t)
              : state.tabs
            return { engineMessages: messages, tabs }
          })
          break
        }
        case 'engine_extension_died': {
          set((state) => {
            const notifications = new Map(state.engineNotifications)
            const keyNotifications = [...(notifications.get(key) || [])]
            keyNotifications.push({
              id: nextMsgId(),
              message: `Extension ${event.extensionName} died — restarting…`,
              level: 'warning',
              timestamp: Date.now(),
            })
            notifications.set(key, keyNotifications)
            return { engineNotifications: notifications }
          })
          break
        }
        case 'engine_extension_respawned': {
          set((state) => {
            const notifications = new Map(state.engineNotifications)
            const keyNotifications = [...(notifications.get(key) || [])]
            keyNotifications.push({
              id: nextMsgId(),
              message: `Extension ${event.extensionName} restarted (attempt ${event.attemptNumber})`,
              level: 'info',
              timestamp: Date.now(),
            })
            notifications.set(key, keyNotifications)
            return { engineNotifications: notifications }
          })
          break
        }
        case 'engine_extension_dead_permanent': {
          set((state) => {
            const messages = new Map(state.engineMessages)
            const msgs = [...(messages.get(key) || [])]
            msgs.push({
              id: nextMsgId(),
              role: 'system' as const,
              content: `Extension ${event.extensionName} crashed ${event.attemptNumber} times in 60s and will not be restarted automatically. Close and reopen this tab to recover.`,
              timestamp: Date.now(),
            })
            messages.set(key, msgs)
            return { engineMessages: messages }
          })
          break
        }
      }
    },
  }
}
