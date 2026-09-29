/**
 * fake-wire — turn a partial preload stub into a working Studio wire.
 *
 * Renderer tests build a small object of `vi.fn()`s, install it as
 * `window.ion`, and assert the component called the right one. That worked
 * while `ElectronStudioHost.shell` WAS the preload. It stopped working when
 * the desktop renderer started routing its bridged verbs over the Studio wire
 * like every other client: the component now sends a `studio_action` and waits
 * for a `studio_action_result`, and a stub with no `hostSendFrame` has nothing
 * to answer it.
 *
 * The obvious repair — rewrite each test to mock `host-instance` instead —
 * would delete what those tests are good at. A stub of `host.shell` skips the
 * bridge table entirely, so a wrong `pack` or a missing entry stays invisible.
 * Wrapping the same stub in a loopback keeps the assertions the test already
 * makes AND puts the real table in the path: the action name, the argument
 * marshalling and the channel mapping all have to be right for the stub to be
 * reached at all.
 *
 * The stub therefore stands in for the SERVER, not for the preload, and its
 * verbs receive the arguments the server action receives — the packed shape.
 * That is the shape worth pinning: mis-packing is precisely the defect class
 * that stayed invisible while only a browser took this path.
 */
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { SHELL_INVOKE, SHELL_SUBSCRIBE } from '../browser-shell-bridge'

type FrameListener = (environmentId: string, frame: StudioFrame) => void
type AnyFn = (...args: unknown[]) => unknown

/** action name → the `IonAPI` verb it was bridged from. */
const VERB_FOR_ACTION = new Map<string, string>(
  Object.entries(SHELL_INVOKE).map(([verb, spec]) => [spec.action, verb]),
)

/** studio_event channel → the `on*` verb it feeds. */
const VERB_FOR_CHANNEL = new Map<string, string>(
  Object.entries(SHELL_SUBSCRIBE).map(([verb, spec]) => [spec.channel, verb]),
)

/**
 * Wrap a preload stub so bridged calls reach it over a loopback wire.
 *
 * The original stub's functions are reused, not copied, so
 * `expect(stub.someVerb).toHaveBeenCalled()` still works.
 */
/**
 * The most recently installed wire's event emitter.
 *
 * A test that wants to simulate "another client changed this" used to
 * re-mock the `on*` verb and call the callback it captured. That reaches the
 * component only when the component subscribed through that verb directly,
 * which it no longer does -- it holds a wire subscription, and the loopback
 * owns the single `on*` subscription behind it. `emitOnChannel` is the
 * replacement: publish on the channel and every wire subscriber hears it,
 * which is what the real server does.
 */
let emitter: ((channel: string, payload: unknown) => void) | null = null

/** Publish a `studio_event` on `channel` to everything subscribed through the installed wire. */
export function emitOnChannel(channel: string, payload?: unknown): void {
  if (!emitter) throw new Error('emitOnChannel: no fake wire is installed')
  emitter(channel, payload)
}

export function installFakeWire<T extends Record<string, unknown>>(stub: T): T {
  const listeners = new Set<FrameListener>()

  // A result goes back on the environment its action was addressed to: the
  // real hosts correlate on it, so answering a remote-addressed call as
  // `local` would leave that call waiting until it timed out.
  function deliver(frame: StudioFrame, environmentId: string = LOCAL_ENVIRONMENT_ID): void {
    for (const listener of [...listeners]) listener(environmentId, frame)
  }

  emitter = (channel, payload) => deliver({ type: 'studio_event', channel, payload } as StudioFrame)

  // Republish each subscribed verb's emissions onto its wire channel. Done at
  // install rather than at first subscribe because the bridged shell's
  // subscription is a frame listener — it carries no channel the stub could be
  // matched against afterwards.
  for (const [channel, verb] of VERB_FOR_CHANNEL) {
    const fn = stub[verb]
    if (typeof fn !== 'function') continue
    ;(fn as AnyFn)((...payload: unknown[]) => {
      deliver({ type: 'studio_event', channel, payload: payload.length === 1 ? payload[0] : payload } as StudioFrame)
    })
  }

  const wire: Record<string, unknown> = {
    // Connection-phase reads every component may make (the Transfer gate asks
    // which other Environments are connected). Defaulted so a test that does
    // not care about connections renders instead of throwing; `stub` wins
    // because it is spread after these.
    hostGetConnections: async () => [],
    // This client's own settings store (Personal and Device keys). Empty and
    // write-accepting by default; a test that cares passes its own.
    hostGetDeviceSettings: async () => ({}),
    hostSetDeviceSetting: async () => {},
    onHostConnections: () => () => {},
    ...stub,

    hostSendFrame(environmentId: string, frame: StudioFrame): void {
      if (frame.type !== 'studio_action') return
      const verb = VERB_FOR_ACTION.get(frame.action)
      // Resolved off the WIRE object, not the original stub: a test that
      // replaces one verb after installing (`window.ion.someVerb = vi.fn()`)
      // writes onto the wire, and dispatching from the stub would keep calling
      // the version it replaced.
      const fn = verb ? (wire[verb] ?? stub[verb]) : undefined
      if (typeof fn !== 'function') {
        // Answer with a failure rather than nothing: a silent drop would hang
        // the caller for its full timeout and surface as an unrelated
        // test-level timeout with nothing naming the real cause.
        deliver({ type: 'studio_action_result', id: frame.id, ok: false, error: { message: `fake wire has no stub for '${frame.action}'` } } as StudioFrame, environmentId)
        return
      }
      void (async () => {
        try {
          const value = await (fn as AnyFn)(...(frame.args ?? []))
          deliver({ type: 'studio_action_result', id: frame.id, ok: true, value } as StudioFrame, environmentId)
        } catch (err) {
          // Carry a thrown failure's code the way the real server does, so a
          // component that branches on it (`unknown_action`, `scope`) sees it.
          const code = err instanceof StudioActionFailure ? err.code : undefined
          deliver({ type: 'studio_action_result', id: frame.id, ok: false, error: { message: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) } } as StudioFrame, environmentId)
        }
      })()
    },

    onHostFrame(cb: FrameListener): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return wire as unknown as T
}
