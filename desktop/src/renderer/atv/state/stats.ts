/**
 * stats — the consumer-side accumulator for cost/token telemetry, feeding
 * the odometers (hover tooltips), wall dashboards, and export footers.
 *
 * Pure data: ingests dispatch_end events (cost, tokens, elapsed — per
 * dispatchId, deduped so backfill replays never double-count) and status
 * events (conversation cost samples for the $/min sparkline). Timestamps
 * are stamped by the caller (presentation layer — never generation/sim).
 */
import type { NormalizedEvent } from '../../../shared/types'

export interface AgentTotals {
  costUsd: number
  elapsedSec: number
  inputTokens: number
  outputTokens: number
  dispatches: number
}

export interface CostSample {
  atMs: number
  conversationCostUsd: number
}

const SAMPLE_CAP = 120

export class AtvStats {
  readonly perAgent = new Map<string, AgentTotals>()
  readonly samples: CostSample[] = []
  private seenDispatchIds = new Set<string>()

  /** Feed one event. `atMs` = wall-clock at ingestion. */
  ingest(event: NormalizedEvent, atMs: number): void {
    if (event.type === 'dispatch_end') {
      const id = event.dispatchId
      if (!id || this.seenDispatchIds.has(id)) return
      this.seenDispatchIds.add(id)
      // Backstop against unbounded growth on very long sessions.
      if (this.seenDispatchIds.size > 5000) this.seenDispatchIds.clear()
      const agent = event.dispatchAgent || 'unknown'
      const totals = this.perAgent.get(agent) ?? { costUsd: 0, elapsedSec: 0, inputTokens: 0, outputTokens: 0, dispatches: 0 }
      totals.costUsd += event.dispatchCost ?? 0
      totals.elapsedSec += event.dispatchElapsed ?? 0
      totals.inputTokens += event.dispatchInputTokens ?? 0
      totals.outputTokens += event.dispatchOutputTokens ?? 0
      totals.dispatches += 1
      this.perAgent.set(agent, totals)
    } else if (event.type === 'status') {
      const cost = (event.fields as { conversationCostUsd?: number } | undefined)?.conversationCostUsd
      if (typeof cost === 'number' && cost > 0) {
        const last = this.samples[this.samples.length - 1]
        if (!last || last.conversationCostUsd !== cost) {
          this.samples.push({ atMs, conversationCostUsd: cost })
          if (this.samples.length > SAMPLE_CAP) this.samples.splice(0, this.samples.length - SAMPLE_CAP)
        }
      }
    }
  }

  totalsFor(agent: string): AgentTotals | null {
    return this.perAgent.get(agent) ?? null
  }

  /** Sum of totals across a set of agents (room-level odometer). */
  teamSpend(agents: readonly string[]): number {
    let sum = 0
    for (const a of agents) sum += this.perAgent.get(a)?.costUsd ?? 0
    return sum
  }

  /** Cost rate ($/min) over the trailing window. 0 when insufficient data. */
  ratePerMinute(nowMs: number, windowMs = 300_000): number {
    const cutoff = nowMs - windowMs
    const windowSamples = this.samples.filter((s) => s.atMs >= cutoff)
    if (windowSamples.length < 2) return 0
    const first = windowSamples[0]
    const last = windowSamples[windowSamples.length - 1]
    const spanMin = (last.atMs - first.atMs) / 60_000
    if (spanMin <= 0) return 0
    return Math.max(0, (last.conversationCostUsd - first.conversationCostUsd) / spanMin)
  }
}
