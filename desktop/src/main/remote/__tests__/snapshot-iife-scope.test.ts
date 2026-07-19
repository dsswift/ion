import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Static guard: the snapshot `executeJavaScript` IIFE must not reference any
 * main-process import (#256 Defect 2).
 *
 * `getRemoteTabStates` builds the iOS snapshot by evaluating a string in the
 * RENDERER global scope via `executeJavaScript`. Any main-process identifier
 * referenced inside that string (e.g. the imported `tabHasExtensions` helper)
 * throws a `ReferenceError` at runtime, which the IIFE's catch swallows —
 * silently degrading EVERY snapshot to the cold-start path (missing groupId /
 * pillColor / conversationInstances). That exact bug shipped once; this test
 * prevents the class from recurring.
 *
 * The IIFE may DEFINE its own local helper named `tabHasExtensions` (an
 * inlined copy of the pure predicate) — that is the fix. This test asserts the
 * helper is never CALLED without first being defined inside the IIFE, i.e. the
 * main-process import is not relied upon inside the renderer string.
 *
 * WI-003 adds guards: deriveEngineParentStatus and the inline status-derivation
 * block (the `if (tabHasExtensions(t))` status fork) are removed. The snapshot
 * projects t.status uniformly — no per-tab-type derivation.
 */

// The legacy IIFE now lives in snapshot-renderer-poll.ts — the cold-start /
// stall fallback of the renderer-push snapshot architecture. The canonical
// projection is renderer/stores/remote-projection.ts (a real module that CAN
// import helpers), behaviorally pinned in remote-projection.test.ts. These
// scope guards still matter for the fallback string, which runs in the
// renderer global scope via executeJavaScript and cannot import anything.
const SNAPSHOT_SRC = readFileSync(
  join(__dirname, '..', 'snapshot-renderer-poll.ts'),
  'utf-8',
)

/** Extract the body of the `executeJavaScript(`...`)` template literal. */
function extractIifeString(src: string): string {
  const start = src.indexOf('executeJavaScript(`')
  expect(start, 'executeJavaScript template literal should exist').toBeGreaterThan(-1)
  const open = src.indexOf('`', start)
  const close = src.indexOf('`', open + 1)
  expect(close, 'executeJavaScript template literal should be closed').toBeGreaterThan(open)
  return src.slice(open + 1, close)
}

describe('snapshot IIFE scope guard (#256 Defect 2)', () => {
  const iife = extractIifeString(SNAPSHOT_SRC)

  it('does not import tabHasExtensions at module scope', () => {
    // The whole-file import was the source of the ReferenceError. After the
    // fix the predicate is inlined inside the IIFE, so the module import is
    // gone.
    expect(SNAPSHOT_SRC).not.toContain(
      "import { tabHasExtensions } from '../../shared/tab-predicates'",
    )
  })

  it('defines a local tabHasExtensions inside the IIFE before any call', () => {
    const defIdx = iife.indexOf('function tabHasExtensions(')
    expect(defIdx, 'IIFE must define its own tabHasExtensions').toBeGreaterThan(-1)
    const firstCall = iife.indexOf('tabHasExtensions(t)')
    // Either there are no calls, or every call comes after the definition.
    if (firstCall > -1) {
      expect(firstCall).toBeGreaterThan(defIdx)
    }
  })

  it('does not reference any main-process import symbol inside the IIFE', () => {
    // Symbols imported at the top of snapshot.ts for MAIN-process use. None
    // of these exist in the renderer global scope, so referencing them in the
    // IIFE string throws ReferenceError.
    const forbidden = [
      'existsSync',
      'readFileSync',
      'readdirSync',
      'readPlanPreviewCached',
      'sessionPlane',
      'isResourceRead',
      'lastMessagePreview',
    ]
    for (const sym of forbidden) {
      expect(iife, `IIFE must not reference main-process symbol "${sym}"`).not.toContain(sym)
    }
  })

  it('logs (does not silently swallow) an IIFE failure in the catch', () => {
    // The original ReferenceError went undetected because the catch returned
    // an empty result with no log. The catch must surface the failure via the
    // preload logWrite bridge — console.* is forbidden in renderer-evaluated
    // code (ADR-019), so the assertion targets the bridge, not console.error.
    expect(iife).toMatch(/catch\s*\(\s*e\s*\)\s*\{[\s\S]*logWrite/)
  })

  it('contains no console.* calls anywhere (ADR-019 zero tolerance)', () => {
    // The pre-extraction IIFE carried console.log / console.error — the exact
    // ADR-019 violations the renderer-push re-architecture removed. Pin that
    // they never come back in the fallback string. Matches CALL sites
    // (console.<method>(), so a prose mention in a comment doesn't trip it.
    expect(iife).not.toMatch(/console\.\w+\(/)
  })

  // --- WI-002 guard: no tabHasExtensions fork in permissionMode/thinkingEffort ---
  it('permissionMode projection does not fork on tabHasExtensions (WI-002)', () => {
    const permIdx = iife.indexOf('permissionMode:')
    expect(permIdx).toBeGreaterThan(-1)
    const permBlock = iife.slice(permIdx, permIdx + 200)
    expect(permBlock).not.toContain('tabHasExtensions(t)')
    expect(permBlock).toContain('activeInst')
  })

  it('thinkingEffort projection does not fork on tabHasExtensions (WI-002)', () => {
    // Target the tab-level thinkingEffort IIFE (not the per-instance one on
    // conversationInstances). The tab-level projection wraps in `(function()`.
    const effortIdx = iife.indexOf('thinkingEffort: (function()')
    expect(effortIdx).toBeGreaterThan(-1)
    const effortBlock = iife.slice(effortIdx, effortIdx + 300)
    expect(effortBlock).not.toContain('tabHasExtensions(t)')
    expect(effortBlock).toContain('activeInst')
  })

  it('permissionMode and thinkingEffort projections use a single read path (WI-002)', () => {
    const permIdx = iife.indexOf('permissionMode:')
    // Target the tab-level thinkingEffort IIFE, not the per-instance one.
    const effortIdx = iife.indexOf('thinkingEffort: (function()')
    const permBlock = iife.slice(permIdx, Math.min(permIdx + 300, effortIdx > -1 ? effortIdx : permIdx + 300))
    const effortBlock = effortIdx > -1 ? iife.slice(effortIdx, effortIdx + 400) : ''
    expect(permBlock).not.toMatch(/tabHasExtensions\(t\)\s*\?/)
    if (effortBlock) {
      expect(effortBlock).not.toMatch(/tabHasExtensions\(t\)\s*\?/)
    }
  })

  // --- WI-003 guard: status-derivation block and deriveEngineParentStatus removed ---
  it('snapshot.ts does not import or reference deriveEngineParentStatus (WI-003)', () => {
    // deriveEngineParentStatus and snapshot-derive.ts are deleted (WI-003).
    // The compensation was needed when t.status could be stranded by the
    // active-instance gate; WI-001 (8690aae3) makes t.status authoritative.
    expect(SNAPSHOT_SRC).not.toContain('deriveEngineParentStatus')
    expect(SNAPSHOT_SRC).not.toContain('snapshot-derive')
  })

  it('IIFE status projection does not fork on tabHasExtensions (WI-003)', () => {
    // The retired derivation was the only site that branched on tabHasExtensions
    // for status. After WI-003, status is projected uniformly via t.status.
    // If someone reintroduces the fork, both assertions below go red.
    const statusIdx = iife.indexOf('status:')
    expect(statusIdx).toBeGreaterThan(-1)
    const statusBlock = iife.slice(statusIdx, statusIdx + 300)
    // No tab-type branch for status.
    expect(statusBlock).not.toMatch(/tabHasExtensions\(t\)/)
    // No derivedStatus variable in this block.
    expect(statusBlock).not.toContain('derivedStatus')
  })

  it('status block uses t.status directly without re-derivation (WI-003 parity)', () => {
    // Parity: any conversation (plain or extension-hosted) projects t.status
    // with no intermediate derivedStatus variable or anyInstanceRunning check
    // upstream of the status key. This would have required the derivation
    // pre-WI-001; WI-001 makes t.status correct at the source.
    expect(iife).not.toContain('anyInstanceRunning')
    expect(iife).not.toContain('derivedStatus')
  })

  // --- HR-2 guard: denial projection does not fork on tab type ---------------
  it('permission-denial projection does not suppress non-plan denials on completed plain tabs (HR-2)', () => {
    // A plain conversation can run background sub-agents that produce non-plan
    // tool denials; those must reach the iOS card queue exactly like an
    // extension tab's. The retired filter dropped all but ExitPlanMode /
    // AskUserQuestion denials for completed plain conversations. If anyone
    // reintroduces it, this goes red.
    //
    // The denial loop is bounded by `pdTools` (the per-instance denial array)
    // and pushes into `queue`. Pin that no tab-type `continue` filter sits
    // between them, and that the specific completed-plain clause is gone.
    const pdIdx = iife.indexOf('pdTools')
    expect(pdIdx, 'denial projection loop should exist').toBeGreaterThan(-1)
    const queueIdx = iife.indexOf('queue.push(pdEntryOut)')
    expect(queueIdx, 'denial queue push should exist').toBeGreaterThan(pdIdx)
    const denialBlock = iife.slice(pdIdx, queueIdx)
    // No tab-type `continue` filter in the denial loop body.
    expect(denialBlock).not.toMatch(/!tabHasExtensions\(t\)[\s\S]*continue/)
    // The specific completed-plain clause is gone.
    expect(denialBlock).not.toContain("t.status === 'completed'")
  })

  it('denial projection still stamps instanceId for extension tabs (HR-2 — scoping kept)', () => {
    // The instanceId scoping (legitimate wire routing for iOS card scoping) is
    // NOT a behavior gate and must remain.
    expect(iife).toContain('if (tabHasExtensions(t)) pdEntryOut.instanceId = activeInstId;')
  })
})

