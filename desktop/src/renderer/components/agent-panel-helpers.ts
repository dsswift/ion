import type { AgentStateUpdate } from '../../shared/types'

/** Read a metadata field with fallback */
export function meta<T>(agent: AgentStateUpdate, key: string, fallback: T): T {
  const val = agent.metadata?.[key]
  return val != null ? (val as T) : fallback
}

const AGENT_COLORS: Record<string, string> = {
  'cloud-architect': '#b4325a',
  'security-officer': '#c88c1e',
  'chief-admin': '#b43232',
  'reliability-engineer': '#32b464',
  'infra-engineer': '#3c96d2',
  'dev-lead': '#8c5ac8',
  'press-secretary': '#8c3cb4',
  'secret-service': '#505050',
  'chief': '#1e3278',
  'specialist': '#144b55',
  'staff': '#411e64',
  'consultant': '#5a410f',
}

function hashColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i)
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 45%, 35%)`
}

export function getAgentColor(agent: AgentStateUpdate): string {
  const color = meta(agent, 'color', '')
  if (color) return color
  if (AGENT_COLORS[agent.name]) return AGENT_COLORS[agent.name]
  return hashColor(meta(agent, 'type', agent.name))
}

export function isAgentVisible(agent: AgentStateUpdate): boolean {
  const visibility = meta<string>(agent, 'visibility', 'ephemeral')
  switch (visibility) {
    case 'always': return true
    case 'sticky': return meta(agent, 'invited', false)
    case 'ephemeral': return agent.status === 'running'
    default: return agent.status === 'running'
  }
}

export function sortAgents(agents: AgentStateUpdate[]): AgentStateUpdate[] {
  const statusOrder: Record<string, number> = { running: 0, done: 1, error: 1, cancelled: 1, idle: 2 }
  const visOrder: Record<string, number> = { always: 0, sticky: 1, ephemeral: 2 }
  return [...agents].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 2
    const sb = statusOrder[b.status] ?? 2
    if (sa !== sb) return sa - sb
    const va = visOrder[meta(a, 'visibility', 'ephemeral')] ?? 9
    const vb = visOrder[meta(b, 'visibility', 'ephemeral')] ?? 9
    if (va !== vb) return va - vb
    return meta(a, 'displayName', a.name).localeCompare(meta(b, 'displayName', b.name))
  })
}

export function getLabelBg(agent: AgentStateUpdate): string {
  const base = getAgentColor(agent)
  if (agent.status === 'done') return '#143e1e'
  if (agent.status === 'error') return '#781414'
  return base
}

export function getStatusSuffix(agent: AgentStateUpdate): string {
  if (agent.status === 'running') return 'responding...'
  const elapsed = agent.metadata?.elapsed as number | undefined
  if (agent.status === 'done' && elapsed != null) return `done ${elapsed}s`
  if (agent.status === 'done') return 'done'
  if (agent.status === 'error') return 'error'
  return ''
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}m ${s}s`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}
