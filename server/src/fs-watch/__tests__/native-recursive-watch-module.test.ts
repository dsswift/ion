/**
 * The tree watcher must not scale its descriptor count with the tree: one
 * recursive `fs.watch` per root. The per-file chokidar scheme it replaces
 * held ~8,000 kqueue descriptors over one checkout and made every git spawn
 * fail with EBADF.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, watch as realWatch } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createNativeRecursiveWatchModule, defaultWatchModule, toIgnorePredicate } from '../native-recursive-watch-module'
import type { WatchEvent, WatchModule } from '../chokidar-watch-module'

const REAL_FS_WATCH_TEST_OPTS = { timeout: 20_000, retry: 2 }

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
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(subscriptions.splice(0).map((s) => s.unsubscribe()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'native-watch-'))
  dirs.push(d)
  return d
}

describe('nativeRecursiveWatchModule', () => {
  it('opens exactly one recursive watch however large the tree is', async () => {
    const dir = scratch()
    for (let i = 0; i < 30; i++) {
      mkdirSync(join(dir, `d${i}`, 'nested'), { recursive: true })
      writeFileSync(join(dir, `d${i}`, 'nested', 'f.txt'), 'x')
    }
    const watchFn = vi.fn(realWatch)
    const mod = createNativeRecursiveWatchModule({ watchFn: watchFn as never })
    const sub = await mod.subscribe(dir, () => undefined, { ignore: ['.git'] })
    subscriptions.push(sub)
    expect(watchFn).toHaveBeenCalledTimes(1)
    expect(watchFn.mock.calls[0][1]).toMatchObject({ recursive: true })
  })

  it('reports create, update, and delete for a nested file', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'sub'))
    const events: WatchEvent[] = []
    const sub = await defaultWatchModule.subscribe(dir, (err, evs) => { if (!err) events.push(...evs) })
    subscriptions.push(sub)
    const file = join(dir, 'sub', 'a.txt')
    const forFile = (): WatchEvent[] => events.filter((e) => e.path === file)
    writeFileSync(file, 'one')
    await waitFor(() => forFile().some((e) => e.type === 'create'))
    // FSEvents coalesces a write that lands inside the create's latency
    // window into that same event, so the update is asserted as "another
    // event for this file arrived after the create", typed update or create.
    const seenAfterCreate = forFile().length
    await new Promise((r) => setTimeout(r, 150))
    writeFileSync(file, 'two')
    await waitFor(() => forFile().length > seenAfterCreate)
    expect(forFile().slice(seenAfterCreate).every((e) => e.type === 'update' || e.type === 'create')).toBe(true)
    unlinkSync(file)
    await waitFor(() => forFile().some((e) => e.type === 'delete'))
  })

  it('reports every event as an update when the subscriber asked for no typing', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = scratch()
    const file = join(dir, 'gone.txt')
    writeFileSync(file, 'x')
    const events: WatchEvent[] = []
    const sub = await defaultWatchModule.subscribe(dir, (err, evs) => { if (!err) events.push(...evs) }, { resolveType: false })
    subscriptions.push(sub)
    unlinkSync(file)
    await waitFor(() => events.some((e) => e.path === file))
    expect(events.every((e) => e.type === 'update')).toBe(true)
  })

  it('applies ignore fragments anywhere in the tree', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, 'src'))
    const events: WatchEvent[] = []
    const sub = await defaultWatchModule.subscribe(dir, (err, evs) => { if (!err) events.push(...evs) }, { ignore: ['.git', 'node_modules'] })
    subscriptions.push(sub)
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '1')
    writeFileSync(join(dir, 'src', 'kept.ts'), '1')
    await waitFor(() => events.some((e) => e.path === join(dir, 'src', 'kept.ts')))
    expect(events.some((e) => e.path.includes('node_modules'))).toBe(false)
  })

  it('stops delivering after unsubscribe', REAL_FS_WATCH_TEST_OPTS, async () => {
    const dir = scratch()
    const events: WatchEvent[] = []
    const sub = await defaultWatchModule.subscribe(dir, (err, evs) => { if (!err) events.push(...evs) })
    await sub.unsubscribe()
    writeFileSync(join(dir, 'late.txt'), 'x')
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toEqual([])
  })

  it('falls back to the injected module where the platform cannot recurse', async () => {
    const fallback: WatchModule = { subscribe: vi.fn(async () => ({ unsubscribe: async () => undefined })) }
    const mod = createNativeRecursiveWatchModule({ platform: 'freebsd', fallback })
    await mod.subscribe('/tmp/x', () => undefined)
    expect(fallback.subscribe).toHaveBeenCalledTimes(1)
  })

  it('translates bare fragments against root-relative paths', () => {
    const ignored = toIgnorePredicate(['.git', 'node_modules'])!
    expect(ignored('.git/index')).toBe(true)
    expect(ignored('desktop/node_modules/x/y.js')).toBe(true)
    expect(ignored('desktop/release/Ion.app/Contents/x')).toBe(false)
  })
})
