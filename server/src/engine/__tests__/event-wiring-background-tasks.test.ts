import { describe, expect, it } from 'vitest'
import { projectEngineEventToWire } from '../event-wiring-wire-projection'

describe('background task remote projection', () => {
  it('projects starts with the desktop-owned task payload', () => {
    expect(projectEngineEventToWire({
      type: 'engine_background_task_started',
      backgroundTaskStarted: {
        taskId: 'task-1',
        toolId: 'tool-1',
        command: 'sleep 1',
        startedAt: 10,
        notifyOnComplete: false,
      },
    }, 'tab-1', null)).toEqual({
      type: 'desktop_background_task_started',
      tabId: 'tab-1',
      instanceId: null,
      task: {
        taskId: 'task-1',
        toolId: 'tool-1',
        command: 'sleep 1',
        startedAt: 10,
        notifyOnComplete: false,
      },
    })
  })

  it('projects terminal fields directly onto the desktop envelope', () => {
    expect(projectEngineEventToWire({
      type: 'engine_background_task_terminal',
      backgroundTaskTerminal: {
        taskId: 'task-1',
        status: 'stopped',
        exitCode: -1,
        elapsedMs: 50,
        command: 'sleep 1',
        outputPath: '/tmp/task-1.out',
        tail: 'stopped',
      },
    }, 'tab-1', 'main')).toEqual({
      type: 'desktop_background_task_terminal',
      tabId: 'tab-1',
      instanceId: 'main',
      taskId: 'task-1',
      status: 'stopped',
      exitCode: -1,
      elapsedMs: 50,
      command: 'sleep 1',
      outputPath: '/tmp/task-1.out',
      tail: 'stopped',
    })
  })

  it('projects all-work stop fields directly onto the desktop envelope', () => {
    expect(projectEngineEventToWire({
      type: 'engine_session_work_stopped',
      sessionWorkStopped: {
        scope: 'all_work',
        cancelledRunId: 'run-1',
        recalledDispatchIds: ['dispatch-1'],
        stoppedBackgroundTaskIds: ['task-1'],
        killedAgentProcessCount: 1,
      },
    }, 'tab-1', 'main')).toEqual({
      type: 'desktop_session_work_stopped',
      tabId: 'tab-1',
      instanceId: 'main',
      scope: 'all_work',
      cancelledRunId: 'run-1',
      recalledDispatchIds: ['dispatch-1'],
      stoppedBackgroundTaskIds: ['task-1'],
      killedAgentProcessCount: 1,
    })
  })
})
