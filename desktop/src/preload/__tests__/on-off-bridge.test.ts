/**
 * Preload `on`/`off` bridge — listener registration and removal.
 *
 * REGRESSION PIN: `on` registers a WRAPPER around the caller's callback (the
 * wrapper forwards the IpcRendererEvent first argument), but `off` used to call
 * `ipcRenderer.removeListener(channel, callback)` with the ORIGINAL callback.
 * The identities differ, so the removal silently no-opped and every `on`
 * registration stayed attached forever.
 *
 * The consequence in the app: `useEngineEvents` registers a dozen channels in
 * an effect and removes them in its cleanup. Any effect re-run (a remount, a
 * dependency change, a StrictMode double-invoke in dev) left the previous
 * listeners live, so one main-process broadcast invoked the handler N times.
 * On IPC.REMOTE_USER_MESSAGE that is N optimistic user bubbles for a single
 * iOS prompt.
 *
 * These tests drive the REAL preload module (not a reimplementation) by
 * mocking 'electron' and capturing the object handed to
 * contextBridge.exposeInMainWorld, so they cannot drift from shipped code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => void

/**
 * ipcRenderer double with Node-EventEmitter removal semantics: removeListener
 * drops the first entry matching by reference identity.
 */
const listeners = new Map<string, Handler[]>()

const fakeIpc = {
  on: vi.fn((channel: string, handler: Handler) => {
    const arr = listeners.get(channel) ?? []
    arr.push(handler)
    listeners.set(channel, arr)
  }),
  removeListener: vi.fn((channel: string, handler: Handler) => {
    const arr = listeners.get(channel)
    if (!arr) return
    const idx = arr.indexOf(handler)
    if (idx !== -1) arr.splice(idx, 1)
  }),
  send: vi.fn(),
  invoke: vi.fn(() => Promise.resolve()),
  once: vi.fn(),
  removeAllListeners: vi.fn(),
  sendSync: vi.fn(),
}

/** Captures the API object the preload module exposes. */
let exposed: Record<string, any> = {}

vi.mock('electron', () => ({
  ipcRenderer: fakeIpc,
  contextBridge: {
    exposeInMainWorld: (_key: string, value: Record<string, any>) => {
      // The module exposes 'ion' and may expose others; keep the one under test.
      if (_key === 'ion') exposed = value
    },
  },
  webUtils: { getPathForFile: () => '' },
}))

function emit(channel: string, ...args: unknown[]): void {
  for (const h of [...(listeners.get(channel) ?? [])]) h({}, ...args)
}

function count(channel: string): number {
  return (listeners.get(channel) ?? []).length
}

beforeEach(async () => {
  listeners.clear()
  fakeIpc.on.mockClear()
  fakeIpc.removeListener.mockClear()
  // Import once; the module registers its API at load time.
  if (Object.keys(exposed).length === 0) await import('../index')
})

describe('preload on/off bridge', () => {
  it('exposes on and off on the ion API', () => {
    expect(typeof exposed.on).toBe('function')
    expect(typeof exposed.off).toBe('function')
  })

  it('off actually removes the listener the wrapper registered', () => {
    const cb = vi.fn()
    exposed.on('ion:test', cb)
    expect(count('ion:test')).toBe(1)

    exposed.off('ion:test', cb)
    expect(count('ion:test')).toBe(0)

    emit('ion:test', 'payload')
    expect(cb).not.toHaveBeenCalled()
  })

  it('REGRESSION: an effect re-run does not accumulate listeners', () => {
    // Simulates useEngineEvents mounting, cleaning up, and mounting again.
    const first = vi.fn()
    exposed.on('ion:remote-user-message', first)
    exposed.off('ion:remote-user-message', first)

    const second = vi.fn()
    exposed.on('ion:remote-user-message', second)

    expect(count('ion:remote-user-message')).toBe(1)

    // ONE broadcast must produce exactly ONE handler invocation. On the old
    // bridge the first listener survived and this fired twice — the
    // duplicate-user-bubble mechanism.
    emit('ion:remote-user-message', { prompt: 'hello' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('re-registering the same callback on one channel is idempotent', () => {
    const cb = vi.fn()
    exposed.on('ion:test', cb)
    exposed.on('ion:test', cb)

    expect(count('ion:test')).toBe(1)
    emit('ion:test')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('forwards the event argument and payload to the callback', () => {
    const cb = vi.fn()
    exposed.on('ion:test', cb)
    emit('ion:test', 'a', 2)
    expect(cb).toHaveBeenCalledWith({}, 'a', 2)
  })

  it('tracks one callback across several channels independently', () => {
    const cb = vi.fn()
    exposed.on('ion:one', cb)
    exposed.on('ion:two', cb)

    exposed.off('ion:one', cb)

    expect(count('ion:one')).toBe(0)
    expect(count('ion:two')).toBe(1)
    emit('ion:two')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('distinct callbacks on one channel are removed independently', () => {
    const a = vi.fn()
    const b = vi.fn()
    exposed.on('ion:test', a)
    exposed.on('ion:test', b)
    expect(count('ion:test')).toBe(2)

    exposed.off('ion:test', a)
    emit('ion:test')

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('off on an unregistered callback is a no-op, not a throw', () => {
    expect(() => exposed.off('ion:test', vi.fn())).not.toThrow()
  })

  it('double off does not remove an unrelated later registration', () => {
    const cb = vi.fn()
    exposed.on('ion:test', cb)
    exposed.off('ion:test', cb)
    exposed.off('ion:test', cb)

    exposed.on('ion:test', cb)
    expect(count('ion:test')).toBe(1)
    emit('ion:test')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
