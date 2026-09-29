import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../persistence/preferences', () => ({ usePreferencesStore: { getState: () => ({}) } }))
vi.mock('../session-store-helpers', () => ({ nextMsgId: vi.fn(() => 'notice-1') }))
const engineStopBackgroundTask = vi.fn()
vi.mock('../host-api', () => ({ echoUserTurnToStudio: vi.fn(), engineStopBackgroundTask: (...args: any[]) => engineStopBackgroundTask(...args) }))
import { createBackgroundTaskSlice } from '../slices/background-task-slice'

function harness() {
  const state: any = {
    tabs: [{ id: 'tab-1' }],
    engineNotifications: new Map(),
  }
  const get = () => state
  const set = (patch: any) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
  Object.assign(state, createBackgroundTaskSlice(set, get))
  return state
}

beforeEach(() => {
  engineStopBackgroundTask.mockReset()
})

describe('stopBackgroundTask', () => {
  it('sends the exact task ID and waits for lifecycle state to remove it', async () => {
    engineStopBackgroundTask.mockResolvedValue({ ok: true, status: 'stopped' })
    const state = harness()
    await expect(state.stopBackgroundTask('tab-1', 'task-7')).resolves.toEqual({ ok: true, status: 'stopped' })
    expect(engineStopBackgroundTask).toHaveBeenCalledWith('tab-1', 'task-7')
    expect(state.engineNotifications.size).toBe(0)
  })

  it('adds an error notification when the engine refuses the stop', async () => {
    engineStopBackgroundTask.mockResolvedValue({ ok: true, status: 'ownership_mismatch' })
    const state = harness()
    await expect(state.stopBackgroundTask('tab-1', 'task-7')).resolves.toMatchObject({ ok: false })
    expect(state.engineNotifications.get('tab-1')?.[0].level).toBe('error')
  })
})
