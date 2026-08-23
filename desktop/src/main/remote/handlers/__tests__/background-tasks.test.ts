import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ stop: vi.fn(), sendToDevice: vi.fn() }))
vi.mock('../../../state', () => ({
  engineBridge: { stopBackgroundTask: (...args: unknown[]) => mocks.stop(...args) },
  state: { remoteTransport: { sendToDevice: (...args: unknown[]) => mocks.sendToDevice(...args) } },
}))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { handleStopBackgroundTask } from '../background-tasks'

beforeEach(() => vi.clearAllMocks())

describe('handleStopBackgroundTask', () => {
  it('forwards the exact task and targets the result to the requesting device', async () => {
    mocks.stop.mockResolvedValue({ ok: true, status: 'stopped' })
    await handleStopBackgroundTask({ type: 'desktop_stop_background_task', tabId: 'tab-1', taskId: 'task-7', requestId: 'req-3' }, 'device-2')
    expect(mocks.stop).toHaveBeenCalledWith('tab-1', 'task-7')
    expect(mocks.sendToDevice).toHaveBeenCalledWith('device-2', {
      type: 'desktop_background_task_stop_result', requestId: 'req-3', taskId: 'task-7', status: 'stopped',
    })
  })

  it('returns a targeted failure without broadcasting', async () => {
    mocks.stop.mockResolvedValue({ ok: true, status: 'not_found' })
    await handleStopBackgroundTask({ type: 'desktop_stop_background_task', tabId: 'tab-1', taskId: 'missing', requestId: 'req-4' }, 'device-3')
    expect(mocks.sendToDevice).toHaveBeenCalledWith('device-3', {
      type: 'desktop_background_task_stop_result', requestId: 'req-4', taskId: 'missing', status: 'not_found',
    })
  })
})
