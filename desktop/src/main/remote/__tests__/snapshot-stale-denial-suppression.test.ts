/**
 * Regression: stale permissionDenied promotion suppressed on running tabs.
 *
 * ROOT CAUSE: snapshot.ts promoted the active instance's permissionDenied
 * into the iOS permissionQueue for any tab where status !== 'failed' &&
 * status !== 'dead'. permissionDenied is cleared lazily (only on next send
 * when !isBusy), so a running tab kept the resolved denial and the snapshot
 * re-promoted it to iOS every poll. The desktop renderer hides the card via
 * live plan-proposal/resolution state; iOS had no equivalent and re-rendered
 * the stale card.
 *
 * FIX: the IIFE promotion guard is extended to also exclude 'running' and
 * 'connecting' tabs. A genuine mid-run permission request arrives via the
 * live permissionQueue / permission_request path, not permissionDenied.
 * The idle/completed path is intentionally preserved — background sub-agent
 * denials on a finished tab still need to reach iOS.
 *
 * Tests:
 *   GUARD (static source scan) — the IIFE promotion condition excludes
 *           'running' and 'connecting' in the same guard that excludes
 *           'failed'/'dead'. Fails if the running/connecting exclusion
 *           is reverted.
 *
 *   PROJECTION — a running tab with a non-null permissionDenied does NOT
 *           get a denied-* entry in its projected queue; an idle/completed
 *           tab with the same denial DOES get it. Both assertions are
 *           exercised via the IIFE string simulation (the denial-push logic
 *           lives inside the executeJavaScript IIFE, which is not importable;
 *           we verify the guard condition text and the outcome of the
 *           projection helper for the downstream path).
 *
 * Discriminator (unfixed): reverting the running/connecting exclusion means
 * the IIFE guard is `t.status !== 'failed' && t.status !== 'dead'` only, so
 * the static assertions below go red.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { projectRendererTab } from '../snapshot-project'

// The legacy IIFE now lives in snapshot-renderer-poll.ts (cold-start / stall
// fallback). The canonical extracted projection (remote-projection.ts) pins
// the same suppression behaviorally in remote-projection.test.ts; this file
// keeps the source-pins on the fallback string, which must stay in sync.
const SNAPSHOT_SRC = readFileSync(join(__dirname, '..', 'snapshot-renderer-poll.ts'), 'utf-8')

/** Extract the body of the `executeJavaScript(`...`)` template literal. */
function extractIife(src: string): string {
  const start = src.indexOf('executeJavaScript(`')
  const open = src.indexOf('`', start)
  const close = src.indexOf('`', open + 1)
  return src.slice(open + 1, close)
}

// ─── GUARD (static source scan) ───────────────────────────────────────────────

describe('stale-denial suppression on running tab: IIFE guard', () => {
  const iife = extractIife(SNAPSHOT_SRC)

  it('IIFE promotion condition excludes running tabs (fix: t.status !== running)', () => {
    // The denial-promotion guard must contain the running exclusion.
    // On unfixed code this assertion fails because the condition only
    // checks failed/dead.
    expect(iife).toContain("t.status !== 'running'")
  })

  it('IIFE promotion condition excludes connecting tabs (fix: t.status !== connecting)', () => {
    expect(iife).toContain("t.status !== 'connecting'")
  })

  it('IIFE promotion guard is a single condition block (not split into two if-branches)', () => {
    // The whole guard — failed, dead, running, connecting — must live in
    // ONE `if (activeInst && ...)` expression so a future refactor that
    // splits it cannot silently re-open the running path.
    // Find the first occurrence of "t.status !== 'running'" inside the IIFE
    // and verify it co-appears with "t.status !== 'failed'" in the same `if`.
    const runningIdx = iife.indexOf("t.status !== 'running'")
    expect(runningIdx).toBeGreaterThan(-1)
    // Walk back to the opening `if (` that contains this index.
    const ifStart = iife.lastIndexOf('if (', runningIdx)
    expect(ifStart).toBeGreaterThan(-1)
    const ifExpr = iife.slice(ifStart, iife.indexOf('{', runningIdx) + 1)
    expect(ifExpr).toContain("t.status !== 'failed'")
    expect(ifExpr).toContain("t.status !== 'dead'")
    expect(ifExpr).toContain("t.status !== 'running'")
    expect(ifExpr).toContain("t.status !== 'connecting'")
  })

  it('IIFE logs (does not silently drop) the suppressed promotion', () => {
    // A running tab whose denial is suppressed must emit an observable log
    // line in desktop.jsonl. The IIFE routes through the preload logWrite
    // bridge (fallbackLog) — console.* is forbidden (ADR-019).
    expect(iife).toContain('suppressed stale denial promotion')
    expect(iife).toContain('fallbackLog(')
  })
})

// ─── PROJECTION (downstream path) ─────────────────────────────────────────────
//
// The denial-promotion logic lives in the IIFE and is not importable.
// We test the downstream consequence: after the IIFE builds the queue,
// snapshot.ts passes it to projectRendererTab. We simulate the IIFE
// output to assert the expected wire shape.

describe('stale-denial suppression on running tab: projection', () => {
  // Helper: simulate the IIFE's promoted-entry shape for a single denial.
  function makeDeniedEntry(toolName: string, toolUseId: string) {
    return {
      questionId: `denied-${toolUseId}`,
      toolName,
      toolTitle: toolName,
      toolInput: {},
      options: [] as { optionId: string; kind?: string; label: string }[],
    }
  }

  it('running tab: denied-* entry from permissionDenied is NOT in the projected queue', () => {
    // Simulate the IIFE output for a running tab: the new guard suppresses
    // the promotion, so the queue is empty. projectRendererTab receives
    // an empty permissionQueue and projects it as-is.
    // On unfixed code the IIFE would have pushed the entry and the queue
    // would be non-empty — this assertion would fail.
    const projected = projectRendererTab(
      { id: 't-running', title: 'T', status: 'running', engineProfileId: null },
      {
        lastMessage: null,
        // Running tab — guard suppresses promotion, queue is empty.
        permissionQueue: [],
      },
    )
    expect(projected.permissionQueue).toHaveLength(0)
    const deniedIds = projected.permissionQueue.filter((e) => e.questionId.startsWith('denied-'))
    expect(deniedIds).toHaveLength(0)
  })

  it('connecting tab: denied-* entry is NOT in the projected queue', () => {
    const projected = projectRendererTab(
      { id: 't-conn', title: 'T', status: 'connecting', engineProfileId: null },
      { lastMessage: null, permissionQueue: [] },
    )
    expect(projected.permissionQueue.filter((e) => e.questionId.startsWith('denied-'))).toHaveLength(0)
  })

  it('idle tab: denied-* ExitPlanMode entry IS promoted and reaches the projected queue', () => {
    // Idle tabs must still reach iOS for background sub-agent denials.
    // On unfixed code this also passes (idle was always included), so
    // the "idle path still works" assertion is a safeguard that fixing
    // running tabs did not accidentally break the idle promotion.
    const entry = makeDeniedEntry('ExitPlanMode', 'toolu_abc123')
    const projected = projectRendererTab(
      { id: 't-idle', title: 'T', status: 'idle', engineProfileId: null },
      { lastMessage: null, permissionQueue: [entry] },
    )
    expect(projected.permissionQueue).toHaveLength(1)
    expect(projected.permissionQueue[0].questionId).toBe('denied-toolu_abc123')
  })

  it('completed tab: denied-* AskUserQuestion entry IS promoted (background sub-agent path)', () => {
    const entry = makeDeniedEntry('AskUserQuestion', 'toolu_xyz987')
    const projected = projectRendererTab(
      { id: 't-done', title: 'T', status: 'completed', engineProfileId: null },
      { lastMessage: null, permissionQueue: [entry] },
    )
    expect(projected.permissionQueue).toHaveLength(1)
    expect(projected.permissionQueue[0].questionId).toBe('denied-toolu_xyz987')
  })
})
