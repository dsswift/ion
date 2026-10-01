import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortForward, PortForwardStartResult } from '@ion/shared/port-forward'

const mocks = vi.hoisted(() => ({
  environmentOfTab: vi.fn<(tabId: string) => string | null>(),
  start: vi.fn<(environmentId: string, remotePort: number) => Promise<PortForwardStartResult>>(),
  stop: vi.fn(async () => true),
  list: vi.fn(async (): Promise<PortForward[]> => []),
  onChange: vi.fn<(cb: (forwards: PortForward[]) => void) => () => void>(() => () => {}),
  hasPortForward: true,
}))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../connection/tab-environment', () => ({ environmentOfTab: mocks.environmentOfTab }))
vi.mock('../../../host/host-instance', () => ({
  host: {
    get portForward() {
      return mocks.hasPortForward ? { start: mocks.start, stop: mocks.stop, list: mocks.list, onChange: mocks.onChange } : null
    },
  },
}))

import { resetPortForwardStoreForTests, usePortForwardStore, webApplicationUrlForThisMachine, wirePortForwards } from '../port-forward-store'

beforeEach(() => {
  for (const fn of [mocks.environmentOfTab, mocks.start, mocks.stop, mocks.list, mocks.onChange]) fn.mockClear()
  mocks.hasPortForward = true
  resetPortForwardStoreForTests()
})

describe('webApplicationUrlForThisMachine', () => {
  it('leaves the URL alone for a conversation on this machine', async () => {
    mocks.environmentOfTab.mockReturnValue('local')
    expect(await webApplicationUrlForThisMachine('tab-1', 'http://localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('forwards the port of a conversation on another Environment and points the URL at the local end', async () => {
    mocks.environmentOfTab.mockReturnValue('env-remote')
    mocks.start.mockResolvedValue({ ok: true, forward: { environmentId: 'env-remote', remotePort: 5173, localPort: 61000, activeStreams: 0 } })

    expect(await webApplicationUrlForThisMachine('tab-1', 'http://localhost:5173/app?x=1')).toBe('http://localhost:61000/app?x=1')
    expect(mocks.start).toHaveBeenCalledWith('env-remote', 5173)
  })

  it('answers null, and records why, when the forward cannot be started', async () => {
    mocks.environmentOfTab.mockReturnValue('env-remote')
    mocks.start.mockResolvedValue({ ok: false, error: 'no free port' })

    expect(await webApplicationUrlForThisMachine('tab-1', 'http://localhost:5173')).toBeNull()
    expect(usePortForwardStore.getState().lastError).toBe('no free port')
  })

  it('answers null on a client that cannot listen on its own machine', async () => {
    mocks.environmentOfTab.mockReturnValue('env-remote')
    mocks.hasPortForward = false

    expect(await webApplicationUrlForThisMachine('tab-1', 'http://localhost:5173')).toBeNull()
  })

  it('leaves a URL that is not on loopback alone, wherever the conversation runs', async () => {
    mocks.environmentOfTab.mockReturnValue('env-remote')
    expect(await webApplicationUrlForThisMachine('tab-1', 'https://example.org/')).toBe('https://example.org/')
    expect(mocks.start).not.toHaveBeenCalled()
  })
})

describe('wirePortForwards', () => {
  it('mirrors the main process list once, however many consumers ask', async () => {
    const forward: PortForward = { environmentId: 'env-remote', remotePort: 5173, localPort: 5173, activeStreams: 2 }
    mocks.list.mockResolvedValue([forward])

    wirePortForwards()
    wirePortForwards()
    await vi.waitFor(() => expect(usePortForwardStore.getState().forwards).toEqual([forward]))

    expect(mocks.onChange).toHaveBeenCalledTimes(1)
    mocks.onChange.mock.calls[0][0]([])
    expect(usePortForwardStore.getState().forwards).toEqual([])
  })
})
