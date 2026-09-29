/**
 * The one `StudioHost` for this renderer bundle (Overlay or Studio — each
 * window gets its own module instance, matching how the preload bridge is
 * already per-window). Every renderer file that used to call the preload
 * bridge directly imports `host` from here instead (spec 12 §Requirements,
 * Phase 3).
 */
import { ElectronStudioHost } from './ElectronStudioHost'
import { BrowserStudioHost } from './BrowserStudioHost'
import type { StudioHost } from './StudioHost'
import { createHostAction } from './host-actions'

let electronHost: ElectronStudioHost | null = null
let browserHost: BrowserStudioHost | null = null

/**
 * Electron's preload ALWAYS defines `window.ion` via contextBridge before a
 * real renderer paints; a genuine browser tab never does (spec 18). This is
 * the one runtime discriminator between the two hosts — everything else in
 * the shared renderer bundle is host-agnostic through the `StudioHost` seam.
 *
 * Resolved on FIRST ACCESS, not at module load, mirroring
 * `ElectronStudioHost.shell`'s own "resolved on every access" rule: a unit
 * test that stubs `window.ion` inside `beforeEach` installs it AFTER this
 * module's top-level statements already ran, so deciding the host class at
 * import time would silently pick `BrowserStudioHost` for every such test.
 * Cached after the first resolution — which class this session runs never
 * changes mid-session, unlike `window.ion`'s own contents.
 */
function resolveHost(): StudioHost {
  // The DECISION is re-made on every access; only the INSTANCES are cached.
  //
  // Caching the decision instead was a trap. `window.ion` is present before
  // a real renderer paints and absent forever in a real browser tab, so in
  // production the answer never changes either way -- but a unit test
  // installs its `window.ion` stub inside `beforeEach`, i.e. after some
  // earlier import has already touched `host`. With the decision cached,
  // that first touch locked the whole file onto BrowserStudioHost, and every
  // later `host.shell` read got the refusal proxy: the graph store silently
  // reported "unavailable in a browser client", and a component that mocks
  // `readImageDataUrl` threw instead. Deciding per access costs one property
  // read and removes the ordering hazard entirely; the instances stay cached
  // so a browser client still opens exactly one socket.
  if (typeof window !== 'undefined' && window.ion) {
    if (!electronHost) electronHost = new ElectronStudioHost()
    return electronHost
  }
  if (!browserHost) browserHost = new BrowserStudioHost()
  return browserHost
}

export const host: StudioHost = new Proxy({} as StudioHost, {
  get(_target, prop) {
    const real = resolveHost()
    const value = Reflect.get(real as object, prop, real)
    // A class method read through the proxy and then called (`host.send(...)`)
    // would otherwise run with `this` bound to the proxy, not `real` — every
    // internal `this.foo` inside the method would silently miss. Binding here
    // is what makes the proxy transparent to method calls, not just reads.
    return typeof value === 'function' ? value.bind(real) : value
  },
})

/**
 * Test-only: drops both cached instances so the next access builds fresh
 * ones. The host CLASS no longer needs resetting (it is decided per access),
 * but a test that wants a clean instance -- one with no listeners or socket
 * from a previous case -- still calls this.
 */
export function resetHostInstanceForTests(): void {
  electronHost = null
  browserHost = null
}

/** `studio_action` request/response bound to `host` (spec 12 §Technical Approach, Phase 3). */
export const action = createHostAction(host)
