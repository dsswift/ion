/**
 * registerAllIpc must never register two `ipcMain.handle` handlers for one
 * channel: Electron throws "Attempted to register a second handler" and the
 * main process dies before its window opens. `registerGitIpc` registers every
 * entry of the shared GIT_HANDLERS table in a loop, so any worktree module
 * that also hand-registers one of those channels is exactly that crash. Four
 * of them did, and the packaged app failed on launch with the first one.
 */
import { describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ handled: [] as string[] }))

vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('electron')>()
  return {
    ...stub,
    app: {
      ...stub.app,
      getAppPath: () => '/fake/app',
      getVersion: () => '0.0.0',
      getPath: () => '/tmp/electron-stub',
    },
    ipcMain: {
      handle: (channel: string) => {
        ipc.handled.push(channel)
      },
      on: () => undefined,
      once: () => undefined,
      removeHandler: () => undefined,
      removeAllListeners: () => undefined,
    },
  }
})

describe('registerAllIpc', () => {
  it('registers every ipcMain.handle channel exactly once', async () => {
    // A build-time define in electron-vite; startup-coordinator reads it at import.
    vi.stubGlobal('__ION_DESKTOP_VERSION__', '0.0.0-test')
    const { registerAllIpc } = await import('../register')
    registerAllIpc()
    const counts = new Map<string, number>()
    for (const channel of ipc.handled) counts.set(channel, (counts.get(channel) ?? 0) + 1)
    const duplicates = [...counts].filter(([, n]) => n > 1).map(([channel, n]) => `${channel} x${n}`)
    // A floor, not a count: enough to prove registerAllIpc ran the native
    // handlers (files, dialogs, attachments, the Studio bridge) rather than
    // returning early. The number shrinks as IPC moves to studio_actions.
    expect(ipc.handled.length).toBeGreaterThan(20)
    expect(duplicates).toEqual([])
  })
})
