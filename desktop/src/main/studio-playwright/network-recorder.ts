/**
 * Network request recorder.
 *
 * Playwright's `page.requests()` looked like the obvious source and is not
 * sufficient: it takes no navigation filter, retains only ~100 entries, and its
 * docs are explicit that returned requests "might be collected to prevent
 * unbounded memory growth" — so the ledger an agent asks about ten seconds
 * later may already be gone. Requests reported through the `request` EVENT are
 * documented as not collected, which is why this records from events instead.
 *
 * What is stored per request is small and fixed: method, url, resource type,
 * status, timing, failure. Bodies and headers are NOT copied here — they are
 * read from the live Playwright objects only when an agent asks for one
 * specific entry, so a page full of large responses costs nothing until
 * someone inspects it.
 *
 * Indices are 1-based and assigned at record time, so an index stays stable
 * even when the list is later filtered. `browser_network_requests` showing
 * entry 7 and `browser_network_request({index: 7})` must mean the same request.
 */
import type { Page, Request } from 'playwright-core'
import { debug as _debug } from '../logger'

const TAG = 'studio-playwright'

/** Bounded so a long-lived tab cannot grow main-process memory without limit. */
export const MAX_RECORDED_REQUESTS = 400

export interface RecordedRequest {
  index: number
  /** Which navigation this belongs to, for the since-navigation default. */
  epoch: number
  method: string
  url: string
  resourceType: string
  status: number | null
  statusText: string
  failure: string | null
  durationMs: number | null
  /** Live handle, used only for on-demand header/body inspection. */
  request: Request
}

interface Ledger {
  entries: RecordedRequest[]
  epoch: number
  nextIndex: number
  dropped: number
  detach(): void
}

const ledgers = new WeakMap<Page, Ledger>()

/**
 * Start recording for a page, once.
 *
 * Called at bind time rather than at first use so the history already covers
 * the operator's own browsing — the failed request that prompted the question
 * is usually older than the question.
 */
export function attachNetworkRecorder(page: Page): void {
  if (ledgers.has(page)) return

  const ledger: Ledger = { entries: [], epoch: 0, nextIndex: 1, dropped: 0, detach: () => { /* replaced below */ } }

  const onRequest = (request: Request): void => {
    const entry: RecordedRequest = {
      index: ledger.nextIndex++,
      epoch: ledger.epoch,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      status: null,
      statusText: '',
      failure: null,
      durationMs: null,
      request,
    }
    ledger.entries.push(entry)
    if (ledger.entries.length > MAX_RECORDED_REQUESTS) {
      ledger.entries.shift()
      ledger.dropped += 1
    }
  }

  const finish = (request: Request): void => {
    const entry = ledger.entries.find((candidate) => candidate.request === request)
    if (!entry) return
    const timing = request.timing()
    if (timing && timing.responseEnd > 0) entry.durationMs = Math.round(timing.responseEnd)
    const failure = request.failure()
    if (failure) entry.failure = failure.errorText
  }

  const onResponse = (response: { request(): Request; status(): number; statusText(): string }): void => {
    const entry = ledger.entries.find((candidate) => candidate.request === response.request())
    if (!entry) return
    entry.status = response.status()
    entry.statusText = response.statusText()
  }

  // A main-frame navigation starts a new epoch, which is what makes the
  // default "current navigation" view meaningful without discarding history.
  const onNavigated = (frame: { parentFrame(): unknown }): void => {
    if (frame.parentFrame() !== null) return
    ledger.epoch += 1
  }

  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfinished', finish)
  page.on('requestfailed', finish)
  page.on('framenavigated', onNavigated)

  ledger.detach = () => {
    page.off('request', onRequest)
    page.off('response', onResponse)
    page.off('requestfinished', finish)
    page.off('requestfailed', finish)
    page.off('framenavigated', onNavigated)
  }

  page.once('close', () => {
    ledger.detach()
    ledgers.delete(page)
    _debug(TAG, 'network recorder detached', { recorded: ledger.nextIndex - 1, dropped: ledger.dropped })
  })

  ledgers.set(page, ledger)
  _debug(TAG, 'network recorder attached', {})
}

export interface RecordedView {
  entries: RecordedRequest[]
  /** Entries evicted by the cap, so truncation is visible rather than silent. */
  dropped: number
  /** True when the recorder started after the page had already loaded. */
  partial: boolean
}

/** Read the ledger, defaulting to the current navigation. */
export function recordedRequests(page: Page, all: boolean): RecordedView {
  const ledger = ledgers.get(page)
  if (!ledger) {
    // No recorder means this page was bound before recording began (a
    // reconnect). Say so rather than reporting an empty network log as if the
    // page had made no requests.
    return { entries: [], dropped: 0, partial: true }
  }
  const entries = all ? [...ledger.entries] : ledger.entries.filter((entry) => entry.epoch === ledger.epoch)
  return { entries, dropped: ledger.dropped, partial: false }
}
