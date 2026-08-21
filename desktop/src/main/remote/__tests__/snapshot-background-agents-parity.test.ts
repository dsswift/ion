/**
 * Snapshot parity: backgroundAgents field visible through the snapshot.
 *
 * Root cause being tested: four "running children" consumers folded only
 * inst.agentStates (empty for plain-conversation dispatch) and ignored
 * inst.statusFields.backgroundAgents (which the engine already emits
 * correctly). This caused a plain orchestrator conversation idle with
 * background agents to show a solid-green idle dot instead of the
 * pulsing-yellow "awaiting children" state.
 *
 * Option B fix: effectiveRunningChildrenCount (TabStripShared.ts) takes
 * max(fromAgentStates, fromBackgroundAgents). The canonical projection
 * (renderer/stores/remote-projection.ts) IMPORTS that helper, so there is no
 * second copy of the fold to keep in sync — the fallback poll calls the same
 * projection through a window global rather than transcribing it.
 *
 * Tests in this file cover PROJECTION PARITY: projectRendererTab passes
 * runningAgentCount and hasRunningChildren through unchanged. The projection
 * sets them; the main-process wire mapping must not drop or zero them.
 *
 * The fold itself (max, not sum; backgroundAgents-only source) is pinned
 * behaviorally in renderer/stores/__tests__/remote-projection.test.ts
 * ('running-children fold') and in TabStripShared-running-children.test.ts.
 * The former source-scan of the transcribed IIFE is retired with the
 * transcription; snapshot-wi-003-status-parity.test.ts guards that the
 * fallback never re-implements the projection again.
 */

import { describe, it, expect } from 'vitest'
import { projectRendererTab } from '../snapshot-project'

// ─── PROJECTION PARITY ────────────────────────────────────────────────────────
//
// projectRendererTab is the main-process function that maps renderer tab state
// onto the wire shape. It must pass runningAgentCount and hasRunningChildren
// through unchanged — the renderer projection computes them, and they must
// survive into the RemoteTabState that reaches iOS.

describe('snapshot projection parity: backgroundAgents → hasRunningChildren', () => {
  const BASE = { lastMessage: null, permissionQueue: [] }

  it('plain tab with backgroundAgents>0: runningAgentCount>0 projected through', () => {
    // Simulates the projection output for a plain orchestrator conversation
    // that is idle but has 2 background agents still running:
    //   inst.agentStates = [] (empty for plain dispatch)
    //   inst.statusFields.backgroundAgents = 2
    //   → IIFE sets runningAgentCount=2, hasRunningChildren=true
    //
    // projectRendererTab must pass both through. Goes RED if the projection
    // zeros out runningAgentCount or drops hasRunningChildren.
    const result = projectRendererTab(
      {
        id: 'plain-tab-1',
        title: 'Plain Orchestrator',
        status: 'idle',
        engineProfileId: null,
        hasRunningChildren: true,
        conversationInstances: [
          {
            id: 'main',
            label: 'main',
            isRunning: false,
            runningAgentCount: 2,  // set by the fixed IIFE
            waitingState: null,
          },
        ],
        activeConversationInstanceId: 'main',
      },
      BASE,
    )

    // The per-instance count must survive
    const inst = (result as any).conversationInstances?.[0]
    expect(inst?.runningAgentCount).toBe(2)

    // The parent aggregate must survive
    expect((result as any).hasRunningChildren).toBe(true)
  })

  it('preserves non-zero backgroundShellCount through the main-process projection', () => {
    const result = projectRendererTab(
      { id: 'shell-tab', backgroundShellCount: 3 },
      BASE,
    )
    expect(result.backgroundShellCount).toBe(3)
  })

  it('plain tab with backgroundAgents=0: hasRunningChildren absent/false projected through', () => {
    // Ensures we don't invent a hasRunningChildren=true when both sources are 0.
    const result = projectRendererTab(
      {
        id: 'plain-tab-2',
        title: 'Plain Idle',
        status: 'idle',
        engineProfileId: null,
        hasRunningChildren: false,
        conversationInstances: [
          { id: 'main', label: 'main', isRunning: false, runningAgentCount: 0, waitingState: null },
        ],
        activeConversationInstanceId: 'main',
      },
      BASE,
    )

    const inst = (result as any).conversationInstances?.[0]
    // runningAgentCount=0 is omitted (falsy-optimized on the wire)
    expect(inst?.runningAgentCount ?? 0).toBe(0)
    expect((result as any).hasRunningChildren ?? false).toBe(false)
  })

  it('both agentStates and backgroundAgents non-zero: max projected (not sum)', () => {
    // agentStates contributed 1 running, backgroundAgents=2 → max=2
    // The IIFE outputs runningAgentCount=2; projection must not change it.
    const result = projectRendererTab(
      {
        id: 'ext-tab-1',
        title: 'Extension Orchestrator',
        status: 'idle',
        engineProfileId: 'cos',
        hasEngineExtension: true,
        hasRunningChildren: true,
        conversationInstances: [
          { id: 'inst-1', label: 'Instance 1', isRunning: false, runningAgentCount: 2, waitingState: null },
        ],
        activeConversationInstanceId: 'inst-1',
      },
      BASE,
    )

    const inst = (result as any).conversationInstances?.[0]
    expect(inst?.runningAgentCount).toBe(2)
    expect((result as any).hasRunningChildren).toBe(true)
  })
})
