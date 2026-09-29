/**
 * A browser tab has no log file of its own, so `POST /log` is its only sink.
 * The client ignored the reply, and the route refuses anything sent before
 * sign-in -- so the lines describing a failing sign-in were exactly the ones
 * thrown away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BrowserLogForwarder, PENDING_STORAGE_KEY, type ForwardableLine, type PendingStorage } from '../browser-log-forward'

/** A fake `/log` whose status the test controls, recording what it received. */
function fakeRoute(initialStatus = 200) {
  const received: ForwardableLine[] = []
  let status = initialStatus
  const post = vi.fn(async (line: ForwardableLine) => {
    if (status === 200) received.push(line)
    return { status }
  })
  return {
    post,
    received,
    accept: () => { status = 200 },
    refuse: (code: number) => { status = code },
    fail: () => { status = 0 },
  }
}

const line = (msg: string): ForwardableLine => ({ level: 'INFO', tag: 'boot', msg })

/** A tab's sessionStorage, as a plain map a test can carry across "page loads". */
function memoryStorage(): PendingStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) },
  }
}

beforeEach(() => {
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear()
})

describe('BrowserLogForwarder', () => {
  it('sends a line straight through when the server accepts it', async () => {
    const route = fakeRoute()
    const forwarder = new BrowserLogForwarder(route.post)

    forwarder.send(line('a normal line'))
    await vi.waitFor(() => expect(route.received.map((l) => l.msg)).toEqual(['a normal line']))
  })

  it('holds what the server refuses before sign-in, and replays it in order after', async () => {
    const route = fakeRoute(401)
    const forwarder = new BrowserLogForwarder(route.post)

    forwarder.send(line('first'))
    forwarder.send(line('second'))
    await vi.waitFor(() => expect(forwarder._stateForTest().buffered).toBe(2))
    expect(route.received).toEqual([])

    route.accept()
    forwarder.send(line('third'))

    await vi.waitFor(() => expect(route.received.map((l) => l.msg)).toEqual(['third', 'first', 'second']))
    expect(forwarder._stateForTest().buffered).toBe(0)
  })

  it('holds a line the server refuses for being over budget', async () => {
    const route = fakeRoute(429)
    const forwarder = new BrowserLogForwarder(route.post)

    forwarder.send(line('too many'))
    await vi.waitFor(() => expect(forwarder._stateForTest().buffered).toBe(1))
  })

  it('holds a line a network failure lost', async () => {
    const route = fakeRoute()
    route.post.mockRejectedValueOnce(new Error('offline'))
    const forwarder = new BrowserLogForwarder(route.post)

    forwarder.send(line('sent while offline'))
    await vi.waitFor(() => expect(forwarder._stateForTest().buffered).toBe(1))
  })

  it('reports what it had to drop rather than passing over it in silence', async () => {
    const route = fakeRoute(401)
    const forwarder = new BrowserLogForwarder(route.post)

    for (let i = 0; i < 205; i++) forwarder.send(line(`line ${i}`))
    await vi.waitFor(() => expect(forwarder._stateForTest().overflowed).toBe(5))

    route.accept()
    forwarder.send(line('the one that gets through'))

    await vi.waitFor(() => {
      const report = route.received.find((l) => l.msg.includes('dropped while the server would not accept them'))
      expect(report?.fields).toMatchObject({ log_suppressed: 5 })
    })
    // The oldest were the ones dropped; the tail survives.
    expect(route.received.some((l) => l.msg === 'line 204')).toBe(true)
    expect(route.received.some((l) => l.msg === 'line 0')).toBe(false)
  })
})

describe('BrowserLogForwarder across a page load', () => {
  // Sign-in is a full page load. The lines refused just before it, and any
  // still in flight when the page left, are the ones that explain it; the
  // next page's forwarder must send them.
  it('sends refused and in-flight lines from the page before sign-in once, after it', async () => {
    const storage = memoryStorage()
    const refused = fakeRoute(401)
    const neverAnswers = vi.fn((_line: ForwardableLine) => new Promise<{ status: number }>(() => {}))
    const pageA = new BrowserLogForwarder(async (l) => (l.msg === 'in flight' ? neverAnswers(l) : refused.post(l)), storage)
    pageA.send(line('refused before sign-in'))
    pageA.send(line('in flight'))
    await vi.waitFor(() => expect(pageA._stateForTest().buffered).toBe(1))

    const after = fakeRoute(200)
    const pageB = new BrowserLogForwarder(after.post, storage)
    pageB.send(line('first line after sign-in'))

    await vi.waitFor(() => expect(after.received.map((l) => l.msg)).toEqual(['first line after sign-in', 'refused before sign-in', 'in flight']))
    await vi.waitFor(() => expect(storage.data.has(PENDING_STORAGE_KEY)).toBe(false))
  })

  // The server may have written a line whose reply the page never read; the
  // replay must carry the same line_id so the server can skip it.
  it('replays an in-flight line under the line_id it was first sent with', async () => {
    const storage = memoryStorage()
    const firstSends: ForwardableLine[] = []
    const pageA = new BrowserLogForwarder(async (l) => {
      firstSends.push(l)
      return new Promise<{ status: number }>(() => {})
    }, storage)
    pageA.send(line('unloading'))
    await vi.waitFor(() => expect(firstSends).toHaveLength(1))

    const after = fakeRoute(200)
    new BrowserLogForwarder(after.post, storage).send(line('next page'))
    await vi.waitFor(() => expect(after.received.map((l) => l.msg)).toContain('unloading'))
    const replayed = after.received.find((l) => l.msg === 'unloading')
    expect(replayed?.fields?.line_id).toBe(firstSends[0].fields?.line_id)
    expect(typeof firstSends[0].fields?.line_id).toBe('string')
  })

  it('stamps each line with the time the page logged it', async () => {
    const route = fakeRoute()
    const forwarder = new BrowserLogForwarder(route.post, memoryStorage())
    const before = Date.now()
    forwarder.send(line('stamped'))
    await vi.waitFor(() => expect(route.received).toHaveLength(1))
    const ts = Date.parse(String(route.received[0].fields?.client_ts))
    expect(ts).toBeGreaterThanOrEqual(before)
  })

  it('carries the overflow count across a page load', async () => {
    const storage = memoryStorage()
    const pageA = new BrowserLogForwarder(fakeRoute(401).post, storage)
    for (let i = 0; i < 203; i++) pageA.send(line(`line ${i}`))
    await vi.waitFor(() => expect(pageA._stateForTest().overflowed).toBe(3))

    const after = fakeRoute(200)
    new BrowserLogForwarder(after.post, storage).send(line('after'))
    await vi.waitFor(() => {
      const report = after.received.find((l) => l.msg.includes('dropped while the server would not accept them'))
      expect(report?.fields).toMatchObject({ log_suppressed: 3 })
    })
  })
})
