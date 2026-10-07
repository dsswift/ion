/**
 * host-actions — `host.action`, the renderer-side convenience that turns
 * every migrated legacy preload-bridge call site into a `studio_action`
 * round trip (spec 12 §Technical Approach, Phase 3: "a thin wrapper that
 * sends studio_action and awaits the result").
 *
 * Correlates the reply itself (by `id`) rather than delegating to the
 * broker's `sendAction` (main-process only, spec 12's `token-source.ts`
 * consumer) — the renderer's copy has to run over `StudioHost.onFrame`, a
 * different event surface than the broker's own `EventEmitter`.
 *
 * Every action is one client span. An action whose arguments already carry
 * a `traceparent` (a prompt, whose `prompt.send` span `lib/action-trace.ts`
 * opened at submit) is sent under that; any other action gets an
 * `action.send` span minted here, so the server's `action.handle` always
 * has a client span to join. The span ends on the result, the refusal or
 * error as its error.
 */
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { startSpan, type Span } from '@ion/shared/trace-context'
import type { StudioHost } from './StudioHost'
import { rWarn } from '../rendererLogger'
import { writeRendererSpan } from '../lib/span-writer'

const ACTION_TIMEOUT_MS = 30_000

/** The span name an action sends under: a prompt keeps `prompt.send` (the dashboards chart it), every other action is `action.send`. */
export function actionSpanName(action: string): 'prompt.send' | 'action.send' {
  return action === 'submit' ? 'prompt.send' : 'action.send'
}

/**
 * Sends `{ type: 'studio_action', action, args }` to `environmentId` and
 * resolves with the result's `value`, or rejects with the refusal/error
 * message (or a timeout) — mirroring `Broker.sendAction`'s contract on the
 * main-process side.
 */
export function createHostAction(host: StudioHost) {
  return function action(environmentId: string, name: string, args: unknown[] = [], options: { activeTabId?: string } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const carried = traceparentFromArgs(args)
      // Only an action nobody has traced yet gets a span here; a prompt's
      // `prompt.send` is open already and ends in `submitWithTrace`.
      const span: Span | null = carried ? null : startSpan(actionSpanName(name), {
        writer: writeRendererSpan,
        kind: 'client',
        attributes: {
          'peer.service': 'ion-server',
          action: name,
          environment_id: environmentId,
          surface: host.capabilities().includes('nativeShell') ? 'studio-desktop' : 'studio-web',
        },
      })
      const sentAt = performance.now()
      const timeout = setTimeout(() => {
        unsubscribe()
        rWarn('host-actions', 'studio_action timed out', { environment_id: environmentId, action: name, id })
        span?.end({ timed_out: true }, `studio_action '${name}' timed out after ${ACTION_TIMEOUT_MS}ms`)
        reject(new Error(`studio_action '${name}' timed out after ${ACTION_TIMEOUT_MS}ms`))
      }, ACTION_TIMEOUT_MS)

      const unsubscribe = host.onFrame((envId, frame) => {
        if (envId !== environmentId || frame.type !== 'studio_action_result' || frame.id !== id) return
        clearTimeout(timeout)
        unsubscribe()
        // The renderer's own view of the round trip, for the IPC-hop figure
        // main derives against its wire time for this same frame id.
        host.noteActionTiming?.(environmentId, id, performance.now() - sentAt)
        if (frame.ok) {
          span?.end({ ok: true })
          resolve(frame.value)
        } else {
          const failure = frame.refusal ?? frame.error
          const message = failure?.message ?? `studio_action '${name}' failed`
          span?.end({ ok: false, ...(failure?.code ? { code: failure.code } : {}) }, message)
          reject(new StudioActionFailure(message, failure?.code))
        }
      })

      const traceparent = carried ?? span?.traceparent
      const frame: StudioFrame = {
        type: 'studio_action',
        id,
        action: name,
        args,
        ...(options.activeTabId ? { activeTabId: options.activeTabId } : {}),
        ...(traceparent ? { traceparent } : {}),
      }
      host.send(environmentId, frame)
    })
  }
}

/** The `traceparent` an action argument carries, lifted onto the frame for a relay to read. */
export function traceparentFromArgs(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && 'traceparent' in arg) {
      const value = (arg as { traceparent?: unknown }).traceparent
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}
