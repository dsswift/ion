/**
 * Import-graph guard for the tool-gate responder.
 *
 * The control plane imports `tool-gate-responder` for `toolGateSessionConfig`,
 * a pure function that builds a config object. That import must stay cheap:
 * `./state` constructs a live `EngineBridge` and `EngineControlPlane` at
 * module-load time, so anything that reaches it from this graph drags a real
 * socket-owning object into every consumer — including ten control-plane test
 * suites, which fail at import with "Cannot access 'mockBridge' before
 * initialization" because their own `../engine-bridge` mock is not yet
 * initialized when `state.ts` runs its constructor.
 *
 * That is exactly what happened when chart publishing was first wired: the
 * responder imported `engineBridge` from `./state` to read the session
 * registry. The fix routes both the session registry and the publish request
 * through the bridge the responder is already handed at wire time.
 *
 * This test pins the seam at the module level rather than asserting on
 * behavior, because the failure is an IMPORT-time side effect: by the time a
 * behavioral test runs, the damage is already done in a different suite.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const MAIN_DIR = __dirname

function importsOf(file: string): string[] {
  const source = readFileSync(join(MAIN_DIR, file), 'utf8')
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])
}

describe('tool-gate-responder import graph', () => {
  it('does not import ./state, which builds a live engine bridge at load', () => {
    expect(importsOf('tool-gate-responder.ts')).not.toContain('./state')
  })

  it('keeps chart publishing a leaf module', () => {
    // The publisher takes its bridge as an argument for the same reason.
    expect(importsOf('chart-resource-publish.ts')).not.toContain('./state')
  })

  it('keeps the chart tool and store free of the live bridge', () => {
    // These are reached from the same responder graph; a `./state` import in
    // any of them reintroduces the identical failure.
    expect(importsOf('studio-chart-tool.ts')).not.toContain('./state')
    expect(importsOf('chart-resource-store.ts')).not.toContain('./state')
  })
})
