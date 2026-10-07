/**
 * The renderer's render-side spans: what this window times between a byte
 * arriving and a pixel changing. Each is a span through `span-writer.ts`
 * (docs/observability/log-schema.md § Spans):
 *
 *   studio.first_paint   the Studio shell's first React commit, a child of
 *                        main's `app.launch` when the window was handed its
 *                        traceparent (`launchTraceparent`)
 *   store.hydrate        mirror boot → the first tabs hydrated into the store
 *   transcript.apply     a transcript delta received → the React commit that
 *                        shows it
 *
 * `transcript.apply` is measured with `performance.mark`/`measure`, so the
 * same figures show in a DevTools performance trace, and sampled: a
 * streaming answer lands many deltas a second, and one span per commit at
 * most every `TRANSCRIPT_SAMPLE_MS` per tab, carrying how many deltas that
 * commit absorbed, is a distribution rather than a flood. Only a tab whose
 * transcript is on screen is timed (`attachTranscriptView`): a hidden tab's
 * deltas would otherwise wait for the operator to switch to it and read as a
 * slow render.
 */
import { startSpan, type Span } from '@ion/shared/trace-context'
import { rDebug } from '../rendererLogger'
import { writeRendererSpan } from './span-writer'

/** The least time between two `transcript.apply` spans for one tab. */
export const TRANSCRIPT_SAMPLE_MS = 500

const perf: Pick<Performance, 'now' | 'mark' | 'measure'> | null = typeof performance !== 'undefined' ? performance : null

function safeMark(name: string): void {
  try {
    perf?.mark(name)
  } catch (err) {
    // silent-ok: a mark is DevTools decoration; the span below carries the figure
    void err
  }
}

function safeMeasure(name: string, start: string, end: string): void {
  try {
    perf?.measure(name, start, end)
  } catch (err) {
    // silent-ok: a measure is DevTools decoration; the span below carries the figure
    void err
  }
}

// ── studio.first_paint ──────────────────────────────────────────────────

let firstPaintDone = false

/**
 * The Studio shell committed for the first time. `startedAtMs` is the
 * renderer's time origin (navigation start) so the span covers the whole
 * renderer boot; `parent` is main's launch traceparent when the shell has
 * one.
 */
export function markStudioFirstPaint(parent?: string | null, now: () => number = Date.now): boolean {
  if (firstPaintDone) return false
  firstPaintDone = true
  safeMark('ion:studio.first_paint')
  const origin = perf && typeof performance.timeOrigin === 'number' ? Math.round(performance.timeOrigin) : now()
  startSpanAt('studio.first_paint', origin, { parent: parent ?? undefined, attributes: {} }, now).end()
  return true
}

// ── store.hydrate ───────────────────────────────────────────────────────

let hydrateSpan: Span | null = null

/** Mirror boot began; the span waits for the first tabs hydration. */
export function startStoreHydrate(parent?: string | null): void {
  if (hydrateSpan) return
  safeMark('ion:store.hydrate:start')
  hydrateSpan = startSpan('store.hydrate', { writer: writeRendererSpan, kind: 'internal', parent: parent ?? undefined })
}

/** The first tabs hydration committed. Later hydrations are not this span. */
export function endStoreHydrate(fields: { environmentId: string; tabCount: number }): boolean {
  if (!hydrateSpan) return false
  safeMark('ion:store.hydrate:end')
  safeMeasure('ion:store.hydrate', 'ion:store.hydrate:start', 'ion:store.hydrate:end')
  hydrateSpan.end({ environment_id: fields.environmentId, tab_count: fields.tabCount })
  hydrateSpan = null
  return true
}

// ── transcript.apply ────────────────────────────────────────────────────

interface PendingDeltas {
  /** Wall clock of the oldest delta not yet committed. */
  firstReceivedMs: number
  count: number
}

const pendingByTab = new Map<string, PendingDeltas>()
const lastSampledByTab = new Map<string, number>()
/** Mounted transcript views per tab (a tab may show in more than one pane). */
const viewsByTab = new Map<string, number>()

/**
 * A transcript view for `tabId` mounted. Returns the detach, which forgets
 * the tab's pending deltas once its last view is gone.
 */
export function attachTranscriptView(tabId: string): () => void {
  viewsByTab.set(tabId, (viewsByTab.get(tabId) ?? 0) + 1)
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    const left = (viewsByTab.get(tabId) ?? 1) - 1
    if (left > 0) {
      viewsByTab.set(tabId, left)
      return
    }
    viewsByTab.delete(tabId)
    forgetTranscriptTab(tabId)
  }
}

/** A transcript delta for `tabId` arrived from the wire. Ignored while no view of the tab is mounted. */
export function noteTranscriptDelta(tabId: string, now: () => number = Date.now): void {
  if (!viewsByTab.has(tabId)) return
  const pending = pendingByTab.get(tabId)
  if (pending) {
    pending.count += 1
    return
  }
  safeMark(`ion:transcript.recv:${tabId}`)
  pendingByTab.set(tabId, { firstReceivedMs: now(), count: 1 })
}

/**
 * The transcript for `tabId` committed. Ends one `transcript.apply` for the
 * deltas that commit absorbed, when the tab's sample window allows it;
 * otherwise the deltas are counted into the next sampled span. Returns
 * whether a span was written.
 */
export function noteTranscriptCommit(tabId: string, now: () => number = Date.now): boolean {
  const pending = pendingByTab.get(tabId)
  if (!pending) return false
  const at = now()
  const last = lastSampledByTab.get(tabId) ?? 0
  if (at - last < TRANSCRIPT_SAMPLE_MS) return false
  pendingByTab.delete(tabId)
  lastSampledByTab.set(tabId, at)
  safeMark(`ion:transcript.commit:${tabId}`)
  safeMeasure(`ion:transcript.apply:${tabId}`, `ion:transcript.recv:${tabId}`, `ion:transcript.commit:${tabId}`)
  startSpanAt('transcript.apply', pending.firstReceivedMs, { attributes: { tab_id: tabId, deltas: pending.count } }, now).end()
  return true
}

/** Forget a tab's pending deltas (its pane is gone). */
export function forgetTranscriptTab(tabId: string): void {
  if (pendingByTab.delete(tabId)) rDebug('render-spans', 'dropped pending transcript deltas for a gone tab', { tab_id: tabId })
  lastSampledByTab.delete(tabId)
}

// ── shared ──────────────────────────────────────────────────────────────

/** A span that began at `startMs`, before anyone could call `startSpan`, written through the renderer span writer. */
export function startSpanAt(
  name: string,
  startMs: number,
  opts: { parent?: string; attributes?: Record<string, unknown>; kind?: 'client' | 'server' | 'internal' },
  now: () => number = Date.now,
): Span {
  return startSpan(name, { writer: writeRendererSpan, kind: opts.kind ?? 'internal', parent: opts.parent, attributes: opts.attributes, now, startMs })
}

/** TEST ONLY. */
export function _resetRenderSpansForTest(): void {
  firstPaintDone = false
  hydrateSpan = null
  pendingByTab.clear()
  lastSampledByTab.clear()
  viewsByTab.clear()
}
