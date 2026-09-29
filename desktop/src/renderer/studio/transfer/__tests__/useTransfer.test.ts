// @vitest-environment jsdom
/**
 * useTransfer — the React state machine driving spec 15's transfer progress
 * card. `transfer-flow.test.ts` pins the export/import/remove sequencing
 * itself; this file pins the hook's OWN job: mapping that sequence (plus the
 * separate `onTransferProgress` byte stream) onto `TransferState`, and the
 * retry/reset lifecycle. `host`/`action` are mocked at the module boundary
 * (the repo convention for the singleton `host-instance` — see
 * `useConvertToWorktreeGate.ts`'s consumers), so no Electron/IPC involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TransferProgress } from '@ion/shared/types-transfer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const progressListeners = new Set<(progress: TransferProgress) => void>()
const hostMock = {
  exportToFile: vi.fn(),
  importFromFile: vi.fn(),
  onTransferProgress: vi.fn((cb: (progress: TransferProgress) => void) => {
    progressListeners.add(cb)
    return () => progressListeners.delete(cb)
  }),
}
const actionMock = vi.fn()

vi.mock('../../../host/host-instance', () => ({
  host: hostMock,
  action: (...args: unknown[]) => actionMock(...args),
}))

// Imported after the mock so the hook picks up the mocked singleton.
const { useTransfer } = await import('../useTransfer')

function emitProgress(progress: TransferProgress): void {
  for (const cb of progressListeners) cb(progress)
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useTransfer', () => {
  let container: HTMLDivElement
  let root: Root
  let result: ReturnType<typeof useTransfer>

  beforeEach(() => {
    hostMock.exportToFile.mockReset()
    hostMock.importFromFile.mockReset()
    actionMock.mockReset()
    progressListeners.clear()

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    function Harness() {
      result = useTransfer()
      return null
    }
    act(() => {
      root.render(React.createElement(Harness))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
  })

  it('walks exporting -> importing -> removing -> succeeded, tracking progress along the way', async () => {
    let resolveExport!: (v: unknown) => void
    let resolveImport!: (v: unknown) => void
    hostMock.exportToFile.mockReturnValue(new Promise((r) => { resolveExport = r }))
    hostMock.importFromFile.mockReturnValue(new Promise((r) => { resolveImport = r }))
    actionMock.mockResolvedValue({ transferredTo: { environmentId: 'env-target', at: 1 } })

    act(() => {
      result.start('env-source', 'tab-1', 'env-target')
    })
    expect(result.status).toBe('exporting')

    act(() => {
      emitProgress({ tabId: 'tab-1', direction: 'export', bytesTransferred: 5, totalBytes: 10 })
    })
    expect(result.status).toBe('exporting')
    expect(result.progress?.bytesTransferred).toBe(5)

    await act(async () => {
      resolveExport({ ok: true, filePath: '/tmp/a.zip', totalBytes: 10, rootConversationId: 'root-1' })
      await flush()
    })
    expect(result.status).toBe('importing')

    act(() => {
      emitProgress({ tabId: 'tab-1', direction: 'import', bytesTransferred: 10, totalBytes: 10 })
    })
    expect(result.progress?.direction).toBe('import')

    await act(async () => {
      resolveImport({ ok: true, rootConversationId: 'root-1', tabId: 'new-tab-1' })
      await flush()
    })
    expect(result.status).toBe('succeeded')
    expect(result.targetEnvironmentId).toBe('env-target')
    expect(result.targetTabId).toBe('new-tab-1')
    expect(result.progress).toBeNull()
  })

  it('ignores progress events for a different tab', async () => {
    hostMock.exportToFile.mockReturnValue(new Promise(() => {}))
    act(() => {
      result.start('env-source', 'tab-2', 'env-target')
    })
    act(() => {
      emitProgress({ tabId: 'some-other-tab', direction: 'export', bytesTransferred: 5, totalBytes: 10 })
    })
    expect(result.progress).toBeNull()
  })

  it('reports a failed status with the step and refusal on an export refusal', async () => {
    hostMock.exportToFile.mockResolvedValue({ ok: false, refusal: { code: 'running', message: 'tab is running' } })

    await act(async () => {
      result.start('env-source', 'tab-3', 'env-target')
      await flush()
    })

    expect(result.status).toBe('failed')
    expect(result.failure).toEqual({ step: 'exporting', refusal: { code: 'running', message: 'tab is running' }, tabId: 'tab-3' })
    expect(result).toMatchObject({ movedCount: 0, totalCount: 1 })
  })

  it('retry re-runs the flow with the last-started args', async () => {
    hostMock.exportToFile.mockResolvedValueOnce({ ok: false, refusal: { code: 'running', message: 'tab is running' } })
    await act(async () => {
      result.start('env-source', 'tab-4', 'env-target')
      await flush()
    })
    expect(result.status).toBe('failed')

    hostMock.exportToFile.mockResolvedValueOnce({ ok: true, filePath: '/tmp/b.zip', totalBytes: 1, rootConversationId: 'root-2' })
    hostMock.importFromFile.mockResolvedValueOnce({ ok: true, rootConversationId: 'root-2', tabId: 'new-tab-4' })
    actionMock.mockResolvedValueOnce({ transferredTo: { environmentId: 'env-target', at: 2 } })

    await act(async () => {
      result.retry()
      await flush()
    })

    expect(result.status).toBe('succeeded')
    expect(hostMock.exportToFile).toHaveBeenLastCalledWith('env-source', 'tab-4', 'env-target', {})
  })

  it('reset returns to idle', async () => {
    hostMock.exportToFile.mockResolvedValue({ ok: false, refusal: { code: 'running', message: 'tab is running' } })
    await act(async () => {
      result.start('env-source', 'tab-5', 'env-target')
      await flush()
    })
    expect(result.status).toBe('failed')

    act(() => {
      result.reset()
    })
    expect(result.status).toBe('idle')
    expect(result.failure).toBeNull()
  })
})
