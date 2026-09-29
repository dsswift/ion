/**
 * bridged-shell — one `host.shell` proxy, two transports.
 *
 * `browser-shell-bridge.ts` says WHICH `IonAPI` verbs cross the Studio wire
 * and what each one maps to. This builds the object that does it, and it is
 * deliberately transport-agnostic: it takes `invoke`, `subscribe` and
 * `sendOneWay` as arguments and knows nothing about sockets, Electron, or
 * which client it is running in.
 *
 * That matters because both clients need the same behaviour for the same
 * verbs. A browser has no choice — the wire is all it has. The desktop has a
 * choice, and taking the other one is what produced the class of bug this
 * module exists to prevent: the renderer reached the same server code through
 * Electron IPC, so the wire path stayed untested in ordinary use and its gaps
 * only surfaced when a browser client finally took it.
 *
 * The difference between the two clients is therefore reduced to one
 * argument. `fallback` decides what an UNBRIDGED verb does:
 *
 *   - a browser throws, because there is nothing else it could do;
 *   - the desktop hands the call to its preload bridge, because the verbs
 *     that are not bridged are the ones that need an operating system
 *     (native dialogs, Finder, screen capture) and Electron has one.
 *
 * Everything in the table behaves identically on both.
 */
import type { IonAPI } from '../../preload/ionapi'
import type { ShellApi } from './shell-api'
import { SHELL_INVOKE, SHELL_SUBSCRIBE, type ShellSubscribeScope } from './browser-shell-bridge'

export interface BridgedShellTransport {
  /** Request/response: one `studio_action`, awaited by id. `timeoutMs` overrides the host's default wait (`ShellInvokeSpec.timeoutMs`). */
  invoke: (action: string, args: unknown[], timeoutMs?: number) => Promise<unknown>
  /** Attach a listener to the `studio_event` channel that feeds a bridged `on*` verb, from the Environments `scope` names. */
  /** `environmentId` names the Environment the event came from (every scope; `all` consumers key by it). */
  subscribe: (channel: string, cb: (payload: unknown, environmentId: string) => void, scope: ShellSubscribeScope) => () => void
  /** Send and forget, for the verbs the preload sends with `send` rather than `invoke`. */
  sendOneWay: (action: string, args: unknown[]) => void
  /**
   * Values that must not go over the wire at all, resolved locally. Read
   * before the bridge table, so a host can override a bridged verb when its
   * own answer is the correct one.
   */
  overrides?: Partial<IonAPI>
  /**
   * What an unbridged verb resolves to. Receives the property name; returning
   * `undefined` means "no such thing here" and the caller sees `undefined`
   * rather than a function that throws on call.
   */
  fallback: (name: string) => unknown
  /**
   * Where `host.shell.foo = fn` writes.
   *
   * `host.shell` used to BE the preload object, so an assignment wrote
   * through to it and reads saw the new value. A host with something behind
   * the bridge must keep that: writing into a proxy-local map instead makes
   * the override outlive whatever the underlying object's own lifetime was.
   * That is not hypothetical -- a test that replaces one verb, then relies on
   * its stub being rebuilt for the next case, silently keeps the override and
   * every later case runs against it.
   *
   * Return false (or omit this) when there is nothing to write through to;
   * the proxy then holds the value itself, which is correct for a client
   * whose bridge has no object underneath it.
   */
  assign?: (name: string, value: unknown) => boolean
}

/**
 * Build the `host.shell` object for one client.
 *
 * Lookup order is overrides, then INVOKE, then SUBSCRIBE, then fallback --
 * most specific first, so a host can always take back a single verb without
 * having to fork the table.
 */
export function createBridgedShell(transport: BridgedShellTransport): ShellApi {
  const overrides = transport.overrides ?? {}
  /**
   * Assignments this proxy had to hold itself, because `assign` declined
   * them. Only a client with nothing behind the bridge gets here.
   */
  const assigned = new Map<string, unknown>()
  return new Proxy(overrides as object, {
    get(target, prop, receiver) {
      const name = String(prop)
      if (assigned.has(name)) return assigned.get(name)
      if (prop in target) return Reflect.get(target, prop, receiver)

      const invokeSpec = SHELL_INVOKE[name]
      if (invokeSpec) {
        return (...args: unknown[]) => {
          const packed = (invokeSpec.pack ?? ((a) => a))(args)
          if (invokeSpec.oneWay) return transport.sendOneWay(invokeSpec.action, packed)
          const reply = transport.invoke(invokeSpec.action, packed, invokeSpec.timeoutMs)
          return invokeSpec.unpack ? reply.then(invokeSpec.unpack) : reply
        }
      }

      const subSpec = SHELL_SUBSCRIBE[name]
      if (subSpec) {
        return (cb: (...payload: unknown[]) => void) => transport.subscribe(
          subSpec.channel,
          // `spread` exists because `broadcast(ch, key, data)` arrives as an
          // array while the preload's listener for that channel takes two
          // parameters. Handing it the array gives `key === [key, data]` and
          // `data === undefined` -- a mismatch invisible until a terminal
          // renders its own key as output.
          subSpec.spread
            ? (payload) => cb(...(Array.isArray(payload) ? payload : [payload]))
            : (payload, environmentId) => cb(payload, environmentId),
          subSpec.scope ?? 'local',
        )
      }

      return transport.fallback(name)
    },
    set(_target, prop, value) {
      const name = String(prop)
      // Write through where the old passthrough wrote, so an override lives
      // and dies with the object it was written onto.
      if (transport.assign?.(name, value)) return true
      assigned.set(name, value)
      return true
    },
    has(target, prop) {
      const name = String(prop)
      return assigned.has(name) || prop in target || name in SHELL_INVOKE || name in SHELL_SUBSCRIBE
    },
  }) as unknown as ShellApi
}

/**
 * The fallback for a client with nothing behind the bridge: every unbridged
 * verb throws when called.
 *
 * Throwing rather than returning a silent no-op is the whole point. A no-op
 * lets the caller believe it succeeded, which is the failure mode that makes
 * a missing bridge entry invisible until someone notices the effect never
 * happened.
 */
export function refuseUnbridged(clientDescription: string): (name: string) => unknown {
  return (name: string) => (..._args: unknown[]) => {
    throw new Error(`${name} is not available in ${clientDescription}`)
  }
}
