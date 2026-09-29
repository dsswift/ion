/**
 * Real-filesystem coverage for `chokidarWatchModule` (git/watcher.ts's and
 * corpus-watch.ts's tests only ever exercise a fake `WatchModule` at the
 * glue-logic level, never this file's actual chokidar wiring: the
 * ignore-pattern translation and the create/update/delete event mapping are
 * new code with no prior coverage from @parcel/watcher).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chokidarWatchModule, type WatchEvent } from '../chokidar-watch-module'

// Real OS-level file watching contends for a shared, limited resource
// (inotify watch descriptors / the fs-watch thread pool) across every
// parallel vitest worker in a full-suite run. `retry` absorbs a genuine
// full-suite contention stall without masking a real regression -- a
// broken adapter fails every time, retried or not; this failed once under
// full-suite load and passed 4/4 times run alone.
const REAL_FS_WATCH_TEST_OPTS = { timeout: 20_000, retry: 2 }

// This suite exercises a real OS-level watcher, not a mock, so its margin
// has to survive the full test suite's parallel worker contention, not just
// an isolated run -- 4s was enough alone (4/4 clean runs) but timed out
// under the full ~3500-test parallel run.
function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) { resolve(); return }
      if (Date.now() - start > timeoutMs) { reject(new Error('waitFor timed out')); return }
      setTimeout(tick, 25)
    }
    tick()
  })
}

const subscriptions: Array<{ unsubscribe: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(subscriptions.splice(0).map((s) => s.unsubscribe()))
})

describe('chokidarWatchModule', () => {
  it('reports a create event for a new file', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chokidar-watch-'))
    const events: WatchEvent[] = []
    const sub = await chokidarWatchModule.subscribe(dir, (err, evs) => {
      if (!err) events.push(...evs)
    })
    subscriptions.push(sub)

    writeFileSync(join(dir, 'new-file.txt'), 'hello')
    await waitFor(() => events.some((e) => e.type === 'create'))

    expect(events.some((e) => e.type === 'create' && e.path === join(dir, 'new-file.txt'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports an update event for a modified file and a delete event for a removed one', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chokidar-watch-'))
    const filePath = join(dir, 'existing.txt')
    writeFileSync(filePath, 'v1')

    const events: WatchEvent[] = []
    const sub = await chokidarWatchModule.subscribe(dir, (err, evs) => {
      if (!err) events.push(...evs)
    })
    subscriptions.push(sub)

    writeFileSync(filePath, 'v2')
    await waitFor(() => events.some((e) => e.type === 'update'))
    expect(events.some((e) => e.type === 'update' && e.path === filePath)).toBe(true)

    unlinkSync(filePath)
    await waitFor(() => events.some((e) => e.type === 'delete'))
    expect(events.some((e) => e.type === 'delete' && e.path === filePath)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it('excludes a bare ignore fragment anywhere in the tree, matching @parcel/watcher\'s semantics', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chokidar-watch-'))
    mkdirSync(join(dir, '.git'))

    const events: WatchEvent[] = []
    const sub = await chokidarWatchModule.subscribe(dir, (err, evs) => {
      if (!err) events.push(...evs)
    }, { ignore: ['.git', 'node_modules'] })
    subscriptions.push(sub)

    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(dir, 'visible.txt'), 'hello')
    await waitFor(() => events.some((e) => e.path === join(dir, 'visible.txt')))

    expect(events.some((e) => e.path.includes(join(dir, '.git')))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('stops delivering events after unsubscribe', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chokidar-watch-'))
    const events: WatchEvent[] = []
    const sub = await chokidarWatchModule.subscribe(dir, (err, evs) => {
      if (!err) events.push(...evs)
    })

    await sub.unsubscribe()
    writeFileSync(join(dir, 'after-unsubscribe.txt'), 'hello')
    await new Promise((r) => setTimeout(r, 300)) // give a wrongly-still-active watcher a chance to fire

    expect(events).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
