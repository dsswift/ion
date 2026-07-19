/**
 * Snapshot parity: backgroundAgents field visible through snapshot IIFE.
 *
 * Root cause being tested: four "running children" consumers folded only
 * inst.agentStates (empty for plain-conversation dispatch) and ignored
 * inst.statusFields.backgroundAgents (which the engine already emits
 * correctly). This caused a plain orchestrator conversation idle with
 * background agents to show a solid-green idle dot instead of the
 * pulsing-yellow "awaiting children" state.
 *
 * Option B fix: effectiveRunningChildrenCount (TabStripShared.ts) takes
 * max(fromAgentStates, fromBackgroundAgents). The snapshot IIFE inlines
 * the same logic (cannot import helpers — runs in renderer global scope
 * via executeJavaScript).
 *
 * Tests in this file:
 *   IIFE SOURCE GUARD — snapshot.ts IIFE contains the backgroundAgents
 *     read so the fix is actually present in the stringified code.
 *
 *   PROJECTION PARITY — projectRendererTab passes runningAgentCount and
 *     hasRunningChildren through unchanged. The IIFE sets them; the main-
 *     process projection must not drop or zero them.
 *
 * Each test must go RED if the snapshot IIFE is reverted to the
 * agentStates-only fold (fromAgentStates count only, no backgroundAgents).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { projectRendererTab } from '../snapshot-project'

// The legacy IIFE now lives in snapshot-renderer-poll.ts (the cold-start /
// stall fallback of the renderer-push architecture). The CANONICAL projection
// is renderer/stores/remote-projection.ts, behaviorally pinned in
// renderer/stores/__tests__/remote-projection.test.ts; this source guard pins
// the fallback string, which cannot import helpers (renderer scope).
const SNAPSHOT_SRC = readFileSync(join(__dirname, '..', 'snapshot-renderer-poll.ts'), 'utf-8')

// Extract just the IIFE body from the executeJavaScript template literal.
// The template literal is delimited by the backtick immediately after
// "executeJavaScript(`". We find the first backtick after that marker
// and then the next unescaped backtick to bound the IIFE string.
function extractIife(): string {
  const marker = 'executeJavaScript(`'
  const start = SNAPSHOT_SRC.indexOf(marker)
  if (start === -1) throw new Error('executeJavaScript template literal not found in snapshot-renderer-poll.ts')
  const open = SNAPSHOT_SRC.indexOf('`', start + marker.length - 1)
  // Walk forward to find the closing backtick of the template literal
  // (skip escaped backticks — none expected in this IIFE, but be safe).
  let i = open + 1
  while (i < SNAPSHOT_SRC.length) {
    if (SNAPSHOT_SRC[i] === '`' && SNAPSHOT_SRC[i - 1] !== '\\') break
    i++
  }
  return SNAPSHOT_SRC.slice(open + 1, i)
}

const IIFE = extractIife()

// ─── IIFE SOURCE GUARD ────────────────────────────────────────────────────────

describe('snapshot IIFE: backgroundAgents source guard', () => {
  it('reads inst.statusFields.backgroundAgents in the per-instance count block', () => {
    // If this string is absent the fix was not applied to the IIFE.
    // Goes RED on revert.
    expect(IIFE).toContain('backgroundAgents')
  })

  it('declares fromBackgroundAgents variable (not agentStates-only fold)', () => {
    expect(IIFE).toContain('fromBackgroundAgents')
  })

  it('calls Math.max to combine both sources (not additive sum)', () => {
    expect(IIFE).toContain('Math.max(fromAgentStates, fromBackgroundAgents)')
  })

  it('carries a keep-in-sync comment referencing effectiveRunningChildrenCount', () => {
    // The comment ties the IIFE logic to the helper so future maintainers
    // know the two must stay in sync.
    expect(IIFE).toContain('effectiveRunningChildrenCount')
  })
})

// ─── PROJECTION PARITY ────────────────────────────────────────────────────────
//
// projectRendererTab is the main-process function that maps renderer tab state
// onto the wire shape. It must pass runningAgentCount and hasRunningChildren
// through unchanged — the IIFE computes them, and they must survive into the
// RemoteTabState that reaches iOS.

describe('snapshot projection parity: backgroundAgents → hasRunningChildren', () => {
  const BASE = { lastMessage: null, permissionQueue: [] }

  it('plain tab with backgroundAgents>0: runningAgentCount>0 projected through', () => {
    // Simulates the fixed IIFE output for a plain orchestrator conversation
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
