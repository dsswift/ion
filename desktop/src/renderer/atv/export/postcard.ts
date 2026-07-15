/**
 * postcard — pure builder for the export footer line: session stats stamped
 * under the office snapshot (agents · tasks · cost · seed).
 */
import type { AgentTotals } from '../state/stats'

export interface PostcardStats {
  agentCount: number
  perAgent: ReadonlyMap<string, AgentTotals>
  conversationCostUsd: number
  seed: string
}

export function postcardFooter(stats: PostcardStats): string {
  let dispatches = 0
  for (const t of stats.perAgent.values()) dispatches += t.dispatches
  const parts = [`${stats.agentCount} agents`, `${dispatches} tasks`]
  if (stats.conversationCostUsd > 0) parts.push(`$${stats.conversationCostUsd.toFixed(2)}`)
  parts.push(`seed ${stats.seed}`)
  return parts.join(' · ')
}
