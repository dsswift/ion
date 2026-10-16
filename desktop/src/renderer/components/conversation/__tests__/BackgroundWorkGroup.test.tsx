// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const stopBackgroundTask = vi.fn(async () => ({ ok: true, status: 'stopped' }))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (state: { stopBackgroundTask: typeof stopBackgroundTask }) => unknown) => selector({ stopBackgroundTask }),
}))
vi.mock('../../../theme', () => ({
  useColors: () => ({ statusAsync: '#f0f', statusError: '#f00', textSecondary: '#aaa' }),
}))

import { BackgroundWorkGroup } from '../BackgroundWorkGroup'

const tool = { id: 'tool-1', role: 'tool' as const, toolName: 'Bash', toolInput: '{"command":"sleep 30"}', toolStatus: 'running' as const, backgroundTaskId: 'task-1', content: '', timestamp: 1 }
const task: { taskId: string; toolId?: string; command: string; startedAt: number; notifyOnComplete: boolean } = { taskId: 'task-1', command: 'sleep 30', startedAt: 1, notifyOnComplete: false }
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  stopBackgroundTask.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(activeTasks = [task]): void {
  act(() => root.render(<BackgroundWorkGroup tabId="tab-1" tools={[tool]} activeTasks={activeTasks} />))
}

describe('BackgroundWorkGroup', () => {
  it('renders only matching active tasks and expands to exact-ID stop controls', async () => {
    render([{ ...task, taskId: 'other' }, task])
    expect(container.textContent).toContain('1 active Bash operation')
    expect(container.textContent).not.toContain('sleep 30')

    act(() => (container.querySelector('[data-testid="background-work-toggle"]') as HTMLButtonElement).click())
    expect(container.textContent).toContain('sleep 30')
    const stop = container.querySelector('[aria-label="Stop background task task-1"]') as HTMLButtonElement
    await act(async () => { stop.click(); await Promise.resolve() })
    expect(stopBackgroundTask).toHaveBeenCalledWith('tab-1', 'task-1')
  })

  it('matches a start event to its tool row before tool-end provides a task id', () => {
    const pendingTool = { ...tool, backgroundTaskId: undefined, toolId: 'tool-1' }
    render([{ ...task, taskId: 'task-live', toolId: 'tool-1' }])
    act(() => root.render(<BackgroundWorkGroup tabId="tab-1" tools={[pendingTool]} activeTasks={[{ ...task, taskId: 'task-live', toolId: 'tool-1' }]} />))
    expect(container.textContent).toContain('1 active Bash operation')
  })

  it('shows a live elapsed clock per task and the oldest task on the header', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(100_000)
      const second = { ...task, taskId: 'task-2', startedAt: 100_000 - 5_000 }
      const first = { ...task, startedAt: 100_000 - 75_000 }
      act(() => root.render(<BackgroundWorkGroup tabId="tab-1" tools={[tool, { ...tool, id: 'tool-2', backgroundTaskId: 'task-2' }]} activeTasks={[first, second]} />))
      const header = () => container.querySelector('[data-testid="background-work-elapsed"]')?.textContent
      expect(header()).toBe('1m 15s')

      act(() => (container.querySelector('[data-testid="background-work-toggle"]') as HTMLButtonElement).click())
      expect(container.querySelector('[data-testid="background-task-elapsed-task-2"]')?.textContent).toBe('5s')

      act(() => { vi.advanceTimersByTime(3_000) })
      expect(header()).toBe('1m 18s')
      expect(container.querySelector('[data-testid="background-task-elapsed-task-2"]')?.textContent).toBe('8s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays mounted until the authoritative inventory removes the task', async () => {
    render()
    act(() => (container.querySelector('[data-testid="background-work-toggle"]') as HTMLButtonElement).click())
    const stop = container.querySelector('[aria-label="Stop background task task-1"]') as HTMLButtonElement
    await act(async () => { stop.click(); expect(container.querySelector('[data-testid="background-task-task-1"]')).toBeTruthy(); await Promise.resolve() })
    render([])
    expect(container.querySelector('[data-testid="background-work-toggle"]')).toBeNull()
  })
})
