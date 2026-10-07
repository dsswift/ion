/**
 * Span collection for a perf run: every `tag=span` log line in the data
 * dir's operational logs and every telemetry span event (payload carries
 * `span_id` and `duration_ms`) inside the run window, grouped by
 * `<service>/<span name>`. Shapes: docs/observability/log-schema.md § Spans.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { summarize, type SpanSummary } from './stats.mjs'
import { log } from './env.mts'

interface SpanLine { ts?: string; tag?: string; component?: string; msg?: string; fields?: { duration_ms?: unknown } }
interface TelemetryEvent { name?: string; ts?: string; payload?: { span_id?: unknown; duration_ms?: unknown } }
interface TelemetryFrame { record?: string; events?: TelemetryEvent[] }

export interface Window { startMs: number; endMs: number }

function inWindow(ts: string | undefined, w: Window): boolean {
  if (!ts) return false
  const t = Date.parse(ts)
  return Number.isFinite(t) && t >= w.startMs && t <= w.endMs
}

function addSample(buckets: Map<string, number[]>, key: string, v: unknown): void {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return
  let arr = buckets.get(key)
  if (!arr) { arr = []; buckets.set(key, arr) }
  arr.push(n)
}

/** Files named `<stem>.jsonl`, `<stem>.jsonl.1`, ... in the data dir (rotations included). */
function logFiles(dataDir: string, exclude: (name: string) => boolean): string[] {
  return readdirSync(dataDir).filter((n) => /\.jsonl(\.\d+)?$/.test(n) && !exclude(n)).map((n) => join(dataDir, n))
}

function eachLine(path: string, fn: (line: string) => void): number {
  let bad = 0
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line) continue
    try { fn(line) } catch { bad++ }
  }
  return bad
}

export function collectSpans(dataDir: string, w: Window): Record<string, SpanSummary> {
  const buckets = new Map<string, number[]>()
  let lines = 0
  let spanLines = 0
  for (const path of logFiles(dataDir, (n) => n.startsWith('telemetry.jsonl'))) {
    const bad = eachLine(path, (line) => {
      lines++
      if (!line.includes('"tag":"span"')) return
      const rec = JSON.parse(line) as SpanLine
      if (rec.tag !== 'span' || !rec.msg || !inWindow(rec.ts, w)) return
      spanLines++
      addSample(buckets, `ion-${rec.component ?? 'unknown'}/${rec.msg}`, rec.fields?.duration_ms)
    })
    if (bad) log('unparseable log lines skipped', { file: path, count: bad })
  }
  let events = 0
  let spanEvents = 0
  for (const path of logFiles(dataDir, (n) => !n.startsWith('telemetry.jsonl'))) {
    const bad = eachLine(path, (line) => {
      const rec = JSON.parse(line) as TelemetryFrame | TelemetryEvent
      // A frame record carries `events[]`; a flat event line is one event.
      const evs = Array.isArray((rec as TelemetryFrame).events) ? (rec as TelemetryFrame).events! : [rec as TelemetryEvent]
      for (const ev of evs) {
        events++
        if (!ev.name || ev.payload?.span_id === undefined || ev.payload.duration_ms === undefined || !inWindow(ev.ts, w)) continue
        spanEvents++
        addSample(buckets, `ion-engine/${ev.name}`, ev.payload.duration_ms)
      }
    })
    if (bad) log('unparseable telemetry lines skipped', { file: path, count: bad })
  }
  log('spans collected', { log_lines: lines, span_lines: spanLines, telemetry_events: events, span_events: spanEvents, keys: buckets.size })
  const out: Record<string, SpanSummary> = {}
  for (const key of [...buckets.keys()].sort()) out[key] = summarize(buckets.get(key)!)
  return out
}
