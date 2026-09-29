// @vitest-environment jsdom
/**
 * bootMirror must never call a host.shell verb a browser client cannot serve.
 *
 * ── The failure this pins ───────────────────────────────────────────────────
 * `browser-shell-bridge.test.ts` already asserts every verb is CLASSIFIED --
 * bridged, or listed as Electron-only. But that list carries a promise in its
 * comment: "unreachable in a browser today because a capability this client
 * does not report gates every call site." Nothing enforced the promise.
 *
 * `initWorktreeSync` and `initConversationTerminalSync` each did two things:
 * subscribe to a bridged delta channel, and PULL a first snapshot over an
 * Electron-only IPC verb. boot-mirror ran both unconditionally, so on a live
 * browser client the pull threw out of a mount effect, the worktree read model
 * never hydrated, and the Inbox rendered against an empty cache and looped
 * (React #185).
 *
 * A classification test cannot catch that: the verb WAS classified. Only
 * running the boot path against a browser-shaped host can. So this drives the
 * real `bootMirror()` through a host that refuses exactly what
 * `BrowserStudioHost` refuses, and fails on the first unbridged call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SHELL_INVOKE, SHELL_SUBSCRIBE } from '../../../host/browser-shell-bridge'

const called: string[] = []
const refused: string[] = []

/** Mirrors BrowserStudioHost: bridged verbs work, everything else throws. */
function browserShell(): unknown {
  return new Proxy({}, {
    get(_target, prop: string) {
      called.push(prop)
      if (prop in SHELL_INVOKE) return () => Promise.resolve(null)
      if (prop in SHELL_SUBSCRIBE) return () => () => {}
      return () => {
        refused.push(prop)
        throw new Error(`${prop} is not available in a browser Studio client (spec 18)`)
      }
    },
  })
}

const host = {
  // A browser client reports no windowMirrorSync: it has no sibling Electron
  // window and none of the main-process IPC verbs that implies.
  capabilities: () => ['engineDirect'],
  shell: browserShell(),
  onFrame: () => () => {},
  // A mirror boot asks the server for the active conversation's rows over
  // the wire (`body-sync.ts`). That is a frame, not a `host.shell` verb, so
  // it is exactly what this test wants to see happen -- it just has to exist
  // on the stub for the boot to get that far.
  send: () => {},
}

vi.mock('../../../host/host-instance', () => ({ host, action: vi.fn(async () => undefined) }))
vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

beforeEach(() => {
  called.length = 0
  refused.length = 0
  vi.resetModules()
})

describe('bootMirror on a browser client', () => {
  it('calls no host.shell verb outside the bridge', async () => {
    const { bootMirror } = await import('../boot-mirror')
    bootMirror()
    await new Promise((r) => setTimeout(r, 0))

    expect(
      refused,
      `bootMirror called ${refused.length} verb(s) a browser cannot serve:\n  ${refused.join('\n  ')}\n` +
      'Bridge them, or fork the call site onto the capability that implies them.',
    ).toEqual([])
  })

  it('actually exercised the boot path (guards against a vacuous pass)', async () => {
    const { bootMirror } = await import('../boot-mirror')
    bootMirror()
    await new Promise((r) => setTimeout(r, 0))
    // A test that asserts "no refusals" would also pass if bootMirror did
    // nothing at all, so pin that it really reached the shell.
    expect(called.length).toBeGreaterThan(0)
  })
})
