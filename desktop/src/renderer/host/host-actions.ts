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
 */
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import type { StudioHost } from './StudioHost'
import { rWarn } from '../rendererLogger'

const ACTION_TIMEOUT_MS = 30_000

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
      const timeout = setTimeout(() => {
        unsubscribe()
        rWarn('host-actions', 'studio_action timed out', { environment_id: environmentId, action: name, id })
        reject(new Error(`studio_action '${name}' timed out after ${ACTION_TIMEOUT_MS}ms`))
      }, ACTION_TIMEOUT_MS)

      const unsubscribe = host.onFrame((envId, frame) => {
        if (envId !== environmentId || frame.type !== 'studio_action_result' || frame.id !== id) return
        clearTimeout(timeout)
        unsubscribe()
        if (frame.ok) {
          resolve(frame.value)
        } else {
          const failure = frame.refusal ?? frame.error
          reject(new StudioActionFailure(failure?.message ?? `studio_action '${name}' failed`, failure?.code))
        }
      })

      const traceparent = traceparentFromArgs(args)
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
