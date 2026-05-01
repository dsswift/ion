import type { TabState, DiscoveredCommand } from '../../shared/types'
import { AVAILABLE_MODELS } from '../stores/sessionStore'

export interface ExecuteCommandDeps {
  tab: TabState | undefined
  staticInfo: { version: string } | null | undefined
  preferredModel: string | null
  discoveredCommands: DiscoveredCommand[]
  clearTab: () => void
  addSystemMessage: (msg: string) => void
}

/**
 * Run a builtin slash command (e.g. /clear, /cost, /help). Pure dispatcher
 * over store actions so InputBar stays focused on the input UI.
 */
export function executeBuiltinCommand(commandName: string, deps: ExecuteCommandDeps): void {
  const { tab, staticInfo, preferredModel, discoveredCommands, clearTab, addSystemMessage } = deps

  switch (commandName) {
    case '/clear':
      clearTab()
      addSystemMessage('Conversation cleared.')
      return
    case '/cost': {
      if (tab?.lastResult) {
        const r = tab.lastResult
        const parts = [
          `$${r.totalCostUsd.toFixed(4)}`,
          `${(r.durationMs / 1000).toFixed(1)}s`,
          `${r.numTurns} turn${r.numTurns !== 1 ? 's' : ''}`,
        ]
        if (r.usage.input_tokens) {
          parts.push(`${r.usage.input_tokens.toLocaleString()} in / ${(r.usage.output_tokens || 0).toLocaleString()} out`)
        }
        addSystemMessage(parts.join(' · '))
      } else {
        addSystemMessage('No cost data yet — send a message first.')
      }
      return
    }
    case '/model': {
      const model = tab?.sessionModel || null
      const version = tab?.sessionVersion || staticInfo?.version || null
      const current = preferredModel || model || 'default'
      const lines = AVAILABLE_MODELS.map((m) => {
        const active = m.id === current || (!preferredModel && m.id === model)
        return `  ${active ? '●' : '○'} ${m.label} (${m.id})`
      })
      const header = version ? `Ion Engine ${version}` : 'Ion Engine'
      addSystemMessage(`${header}\n\n${lines.join('\n')}\n\nSwitch model: type /model <name>\n  e.g. /model sonnet`)
      return
    }
    case '/mcp': {
      if (tab?.sessionMcpServers && tab.sessionMcpServers.length > 0) {
        const lines = tab.sessionMcpServers.map((s) => {
          const icon = s.status === 'connected' ? '✓' : s.status === 'failed' ? '✗' : '○'
          return `  ${icon} ${s.name} — ${s.status}`
        })
        addSystemMessage(`MCP Servers (${tab.sessionMcpServers.length}):\n${lines.join('\n')}`)
      } else if (tab?.conversationId) {
        addSystemMessage('No MCP servers connected in this session.')
      } else {
        addSystemMessage('No MCP data yet — send a message to start a session.')
      }
      return
    }
    case '/skills': {
      if (discoveredCommands.length > 0) {
        const projectCmds = discoveredCommands.filter((c) => c.scope === 'project')
        const userCmds = discoveredCommands.filter((c) => c.scope === 'user')
        const lines: string[] = []
        if (projectCmds.length > 0) {
          lines.push('Project:')
          projectCmds.forEach((c) => lines.push(`  /${c.name}`))
        }
        if (userCmds.length > 0) {
          lines.push('User:')
          userCmds.forEach((c) => lines.push(`  /${c.name}`))
        }
        addSystemMessage(`Available commands (${discoveredCommands.length}):\n${lines.join('\n')}`)
      } else {
        addSystemMessage('No commands found in ~/.ion/commands/ or .ion/commands/')
      }
      return
    }
    case '/help': {
      const lines = [
        '/clear — Clear conversation history',
        '/cost — Show token usage and cost',
        '/model — Show model info & switch models',
        '/mcp — Show MCP server status',
        '/skills — Show available skills',
        '/help — Show this list',
      ]
      addSystemMessage(lines.join('\n'))
      return
    }
  }
}

export interface ResolveModelSwitchResult {
  ok: boolean
  modelId?: string
  modelLabel?: string
  query: string
}

/**
 * Match a `/model <query>` arg against AVAILABLE_MODELS. Returns the model
 * id+label on a hit, or {ok:false, query} for the caller to render a
 * helpful error message.
 */
export function resolveModelSwitch(query: string): ResolveModelSwitchResult {
  const lowered = query.toLowerCase()
  const match = AVAILABLE_MODELS.find((m: { id: string; label: string }) =>
    m.id.toLowerCase().includes(lowered) || m.label.toLowerCase().includes(lowered),
  )
  if (match) return { ok: true, modelId: match.id, modelLabel: match.label, query }
  return { ok: false, query }
}
