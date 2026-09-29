/**
 * No verb may reach a browser Studio client without a way to succeed or a
 * reason to be hidden.
 *
 * This replaces a narrower test that mapped four settings categories to their
 * call sites by hand. It caught the Visualizer's false `visualizerDirect`
 * claim and missed an identical (since-deleted) `filesDirect` one, for the only reason a
 * hand-written list ever misses anything: the list was written once and the
 * code kept moving. A check that enumerates part of the surface certifies that
 * part and quietly certifies nothing about the rest.
 *
 * So the gate is the audit itself (`scripts/host-surface-audit.mjs`), which
 * reads the whole `host.shell` surface out of the preload, the bridge table,
 * the server's action registry and every renderer call site. Three classes of
 * finding fail the build:
 *
 *   BROKEN_UNGATED          called with no guard and no bridge — throws on reach
 *   BROKEN_OVERCLAIMED_GATE guarded by a capability the browser HOLDS, unbridged
 *   BROKEN_NO_SERVER_ACTION bridged to a studio_action the server never registers
 *
 * Closing one is not a matter of editing a list: bridge the verb, gate it on a
 * capability the browser genuinely lacks, give it a browser equivalent, or add
 * an anchored entry to the script's `RESOLVED_ELSEWHERE` — and that anchor is
 * re-verified on every run, so an exemption dies with the guard it cites.
 */
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

interface AuditRow {
  verb: string
  class: string
  gates: string
  browserHasGate: string
  sites: string[]
}

function runAudit(): AuditRow[] {
  const out = execFileSync('node', [join(REPO, 'scripts', 'host-surface-audit.mjs'), '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return (JSON.parse(out) as { rows: AuditRow[] }).rows
}

/** One line per finding, naming the file to open — a bare verb name is not actionable. */
function describeRows(rows: AuditRow[]): string {
  return rows
    .map((r) => `  ${r.verb} [${r.class}]${r.browserHasGate ? ` browser already holds: ${r.browserHasGate}` : ''}\n    ${r.sites.join('\n    ')}`)
    .join('\n')
}

describe('host surface has no browser gaps', () => {
  const rows = runAudit()

  it('no verb is called unguarded and unbridged', () => {
    const broken = rows.filter((r) => r.class === 'BROKEN_UNGATED')
    expect(broken.length, `a browser client throws on reaching these:\n${describeRows(broken)}`).toBe(0)
  })

  it('no capability the browser holds gates an unbridged verb', () => {
    // The gate opens because the capability is claimed, and the call behind it
    // throws. This is the `visualizerDirect` defect in its general form.
    const broken = rows.filter((r) => r.class === 'BROKEN_OVERCLAIMED_GATE')
    expect(broken.length, `these gates open onto an unbridged call:\n${describeRows(broken)}`).toBe(0)
  })

  it('every bridged verb targets a studio_action the server registers', () => {
    const broken = rows.filter((r) => r.class === 'BROKEN_NO_SERVER_ACTION')
    expect(broken.length, `bridged to an action no server handler answers:\n${describeRows(broken)}`).toBe(0)
  })

  it('the audit still sees the surface it is meant to cover', () => {
    // A regex that stops matching turns this whole file green by describing
    // nothing. Real numbers in the hundreds; the floors only catch collapse.
    // The surface shrinks as preload verbs move to studio_actions (P2-5),
    // so the floor sits well under the current count, not at it.
    expect(rows.length).toBeGreaterThan(150)
    expect(rows.filter((r) => r.class === 'BRIDGED').length).toBeGreaterThan(100)
  })
})
