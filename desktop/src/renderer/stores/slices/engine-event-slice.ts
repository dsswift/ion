import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { formatClearDivider } from '../../../shared/clear-divider'

/**
 * Per-tab cache of extension-registered command names, populated by
 * engine_command_registry snapshots emitted from the Go engine. Used by
 * the slash-autocomplete UI in InputBar so extension commands appear in
 * the menu alongside filesystem `.md` discoveries. Keyed by engine session
 * key (tabId or `${tabId}:${instanceId}`) — autocomplete reads under the
 * active tab/instance combination.
 *
 * Snapshot semantics: every event REPLACES the prior set. An empty
 * `commands: []` is the authoritative "no extension commands" signal and
 * clears the entry. Mirrors the main-process cache in
 * `desktop/src/main/state.ts:extensionCommandRegistry`.
 */
const extensionCommandsByKey = new Map<string, Array<{ name: string; description?: string }>>()

/** Get a snapshot of the current extension commands for an engine session key.
 *  Used by autocomplete; returns an empty array when no commands are cached. */
export function getRendererExtensionCommands(key: string): Array<{ name: string; description?: string }> {
  return extensionCommandsByKey.get(key) ?? []
}

export function createEngineEventSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    handleEngineEvent: (key, event) => {
      // engine_command_registry and engine_command_result are CROSS-CUTTING
      // events that apply to both CLI tabs (bare tabId key) and engine tabs
      // (compound tabId:instanceId key). We dispatch on them BEFORE the
      // engine-tab-only guard below so they reach the correct slice.
      if (event.type === 'engine_command_registry') {
        const listings = Array.isArray(event.commands) ? event.commands : []
        if (listings.length === 0) {
          extensionCommandsByKey.delete(key)
        } else {
          extensionCommandsByKey.set(key, listings.map((l: { name: string; description?: string }) => ({ name: l.name, description: l.description })))
        }
        // No store mutation here — autocomplete reads via
        // getRendererExtensionCommands() during keystroke handling, not
        // through reactive subscriptions. The renderer re-renders on the
        // next keystroke and pulls a fresh list.
        return
      }
      if (event.type === 'engine_command_result') {
        // Engine confirms a command dispatch. We use this for two things:
        //   1. The /clear divider — drawn when command='clear' and
        //      commandError is empty. The unified pipeline collapsed the
        //      legacy renderer-side divider injection into this single
        //      engine-driven trigger so desktop and iOS render the divider
        //      from the same signal.
        //   2. (Future) /export markdown banner, /compact confirmation,
        //      and any extension-emitted command result that wants a
        //      visible system bubble.
        //
        // For now we only branch on /clear because the other built-ins
        // (export, compact) had no renderer-side feedback in the legacy
        // path either.
        const cmdName = event.command || ''
        const failed = !!event.commandError
        const tabIdForCmd = key.includes(':') ? key.split(':')[0] : key
        if (cmdName === 'clear' && !failed) {
          const divider = formatClearDivider(new Date())
          if (key.includes(':')) {
            // Engine tab — insert into engineMessages keyed by the compound key.
            set((state) => {
              const messages = new Map(state.engineMessages)
              const msgs = [...(messages.get(key) || [])]
              msgs.push({ id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() })
              messages.set(key, msgs)
              return { engineMessages: messages }
            })
          } else {
            // CLI tab — insert into the tab's local messages array.
            set((state) => ({
              tabs: state.tabs.map((t) => t.id === tabIdForCmd
                ? { ...t, messages: [...t.messages, { id: nextMsgId(), role: 'system' as const, content: divider, timestamp: Date.now() }] }
                : t),
            }))
          }
        }
        return
      }

      if (!key.includes(':')) return

      const tabId = key.split(':')[0]
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, lastEventAt: Date.now() } : t)),
      }))
      switch (event.type) {
        case 'engine_agent_state': {
          // Engine contract: `engine_agent_state` is a COMPLETE SNAPSHOT
          // of every agent the engine considers live. Replace local state
          // with the payload — do not merge, do not retain prior entries.
          // The engine guarantees a follow-up snapshot for every
          // terminating agent, so any agent missing from this payload is
          // genuinely no longer live. See docs/architecture/agent-state.md.
          //
          // Historically this slice retained "historical" agents (status
          // != running with a conversationId) when the engine sent an
          // empty array. That preservation rule was the bug behind the
          // iOS "stale agent" reports — the desktop renderer would hold
          // onto rows the engine had already retired, and on reconnect
          // sendCurrentEngineState would forward those stale rows to iOS.
          // Removed: the engine is authoritative.
          const agents = event.agents || []
          const statusSummary = agents.map((a: any) => `${a.name}:${a.status}`).join(',')
          console.log(`[store] agent_state: key=${key} count=${agents.length} replaced [${statusSummary}]`)
          set((state) => {
            const agentStates = new Map(state.engineAgentStates)
            agentStates.set(key, agents)
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
        case 'engine_events_dropped': {
          set((state) => {
            const notifications = new Map(state.engineNotifications)
            const keyNotifications = [...(notifications.get(key) || [])]
            keyNotifications.push({
              id: nextMsgId(),
              message: `Connection fell behind — ${event.count} events dropped. State may be stale.`,
              level: 'warning',
              timestamp: Date.now(),
            })
            notifications.set(key, keyNotifications)
            return { engineNotifications: notifications }
          })
          break
        }
        case 'engine_compacting': {
          if (event.active) {
            set((state) => {
              const workingMessages = new Map(state.engineWorkingMessages)
              workingMessages.set(key, 'Compacting...')
              return { engineWorkingMessages: workingMessages }
            })
          } else {
            set((state) => {
              const workingMessages = new Map(state.engineWorkingMessages)
              workingMessages.set(key, '')
              if (!event.messagesBefore && !event.summary) {
                return { engineWorkingMessages: workingMessages }
              }
              const parts = ['[Compaction]']
              if (event.strategy) parts.push(event.strategy)
              if (event.messagesBefore && event.messagesAfter != null) {
                parts.push(`${event.messagesBefore} → ${event.messagesAfter} messages`)
              }
              if (event.clearedBlocks) parts.push(`${event.clearedBlocks} blocks cleared`)
              let content = parts.join(' · ')
              if (event.summary) content += '\n\n' + event.summary
              const messages = new Map(state.engineMessages)
              const msgs = [...(messages.get(key) || [])]
              msgs.push({
                id: nextMsgId(),
                role: 'system' as const,
                content,
                timestamp: Date.now(),
              })
              messages.set(key, msgs)
              return { engineWorkingMessages: workingMessages, engineMessages: messages }
            })
          }
          break
        }
      }
    },
  }
}
