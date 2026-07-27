import { describe, it, expect } from 'vitest'
import { evaluateRemoteCloseGuard, formatRemoteCloseGuardRefusal } from '../handlers/tabs-close-guard'
import type { ProjectedRendererTab } from '../../../shared/remote-projection-types'

/**
 * The iOS close path had no guard at all, so the phone could close a tab the
 * desktop refuses to close on Cmd+W — killing the engine session and orphaning
 * running agents or outstanding background bash commands.
 *
 * These pin the wire-shape equivalent of the renderer's `evaluateCloseGuard`:
 * same rule, same three signals (orchestrator running, running agents,
 * outstanding shells), read from the snapshot instead of conversationPanes.
 */

function makeTab(over: Partial<ProjectedRendererTab> = {}): ProjectedRendererTab {
  return {
    id: 'tab-1',
    title: 'Tab',
    customTitle: null,
    status: 'idle',
    workingDirectory: '/tmp',
    permissionMode: 'auto',
    permissionQueue: [],
    lastMessageContent: null,
    lastActivityTs: 0,
    ...over,
  } as ProjectedRendererTab
}

describe('evaluateRemoteCloseGuard', () => {
  it('allows closing an idle tab with no work in flight', () => {
    const r = evaluateRemoteCloseGuard(makeTab())
    expect(r).toEqual({ blocked: false, orchestratorRunning: false, agentCount: 0, shellCount: 0 })
  })

  it('blocks while the orchestrator is running (tab-level status)', () => {
    const r = evaluateRemoteCloseGuard(makeTab({ status: 'running' }))
    expect(r.blocked).toBe(true)
    expect(r.orchestratorRunning).toBe(true)
  })

  it('blocks while connecting — a starting run is still a run', () => {
    expect(evaluateRemoteCloseGuard(makeTab({ status: 'connecting' })).blocked).toBe(true)
  })

  it('blocks on a per-instance running orchestrator even when the tab reads idle', () => {
    const r = evaluateRemoteCloseGuard(makeTab({
      conversationInstances: [{ id: 'a', label: 'A', isRunning: true }],
    }))
    expect(r.blocked).toBe(true)
    expect(r.orchestratorRunning).toBe(true)
  })

  it('blocks on running dispatched agents, summed across instances', () => {
    const r = evaluateRemoteCloseGuard(makeTab({
      conversationInstances: [
        { id: 'a', label: 'A', runningAgentCount: 1 },
        { id: 'b', label: 'B', runningAgentCount: 2 },
      ],
    }))
    expect(r.blocked).toBe(true)
    expect(r.agentCount).toBe(3)
  })

  it('blocks on outstanding background shells — the dimension iOS could bypass', () => {
    const r = evaluateRemoteCloseGuard(makeTab({
      conversationInstances: [
        { id: 'a', label: 'A', backgroundShellCount: 2 },
        { id: 'b', label: 'B', backgroundShellCount: 1 },
      ],
    }))
    expect(r.blocked).toBe(true)
    expect(r.shellCount).toBe(3)
    // Not conflated with the agent signal.
    expect(r.agentCount).toBe(0)
  })

  it('allows the close when instances exist but report no work', () => {
    const r = evaluateRemoteCloseGuard(makeTab({
      conversationInstances: [
        { id: 'a', label: 'A', isRunning: false, runningAgentCount: 0, backgroundShellCount: 0 },
      ],
    }))
    expect(r.blocked).toBe(false)
  })

  it('treats a tab projected by an older desktop (fields absent) as no work', () => {
    const r = evaluateRemoteCloseGuard(makeTab({
      conversationInstances: [{ id: 'a', label: 'A' }],
    }))
    expect(r.blocked).toBe(false)
    expect(r.agentCount).toBe(0)
    expect(r.shellCount).toBe(0)
  })

  it('does NOT block an unknown tab — refusing one we cannot see would strand it', () => {
    expect(evaluateRemoteCloseGuard(undefined).blocked).toBe(false)
    expect(evaluateRemoteCloseGuard(null).blocked).toBe(false)
  })
})

describe('formatRemoteCloseGuardRefusal', () => {
  it('carries all three signals and a truncated id for the log', () => {
    const fields = formatRemoteCloseGuardRefusal('abcdef0123456789', {
      blocked: true, orchestratorRunning: false, agentCount: 2, shellCount: 3,
    })
    expect(fields).toEqual({
      tab_id: 'abcdef01',
      orchestrator_running: false,
      agent_count: 2,
      background_shells: 3,
    })
  })
})
