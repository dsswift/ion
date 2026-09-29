/**
 * commands — reverse `studio_command` routing (manifest contract C3, Phase 2
 * pseudocode `commands.send`).
 *
 * `graph.*` and `browser.*` tool calls originate in main (a model asked for
 * `graph_fit`, `browser_click`, ...) and need an answer FROM a Studio client
 * that owns the relevant renderer surface. `send()` picks the connection
 * advertising the tool's capability (`graph` or `browser`, the prefix before
 * the first `.`), sends it a `studio_command`, and resolves once the
 * matching `studio_command_result` arrives or `timeoutMs` elapses. With no
 * capable connection attached, it rejects with `StudioRequiredError` — the
 * exact "Studio required" tool-error case `studio-graph/tools.ts` and
 * `studio-playwright/renderer-bridge.ts` already format for the model.
 */
import { log as _log, warn as _warn } from '../logger'
import type { Connection, ConnectionRegistry } from './connection'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-commands', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-commands', msg, fields)
}

export class StudioRequiredError extends Error {
  constructor(message = 'Studio required') {
    super(message)
    this.name = 'StudioRequiredError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let nextCommandId = 1

/** The capability a command name requires, derived from its `<capability>.<verb>` prefix. */
export function capabilityForCommand(command: string): string {
  const dot = command.indexOf('.')
  return dot === -1 ? command : command.slice(0, dot)
}

/** Route a `studio_command_result` frame back to whichever `send()` call is awaiting it. */
export function handleCommandResult(frame: Extract<StudioFrame, { type: 'studio_command_result' }>): void {
  const entry = pending.get(frame.id)
  if (!entry) {
    warn('command result arrived with no matching pending command', { id: frame.id })
    return
  }
  pending.delete(frame.id)
  clearTimeout(entry.timer)
  if (frame.ok) {
    entry.resolve(frame.value)
  } else {
    entry.reject(new Error(frame.error ?? 'studio command failed'))
  }
}

/**
 * Send one reverse command to the connection that owns `environmentId` and
 * advertises the required capability. This process is one environment, so
 * `environmentId` is accepted for the manifest-specified call shape and
 * logged, but routing itself only ever has one environment to pick from.
 */
export function send(registry: ConnectionRegistry, environmentId: string, command: string, args: unknown, timeoutMs: number): Promise<unknown> {
  const capability = capabilityForCommand(command)
  const conn: Connection | undefined = registry.findByCapability(capability)
  if (!conn) {
    warn('reverse command refused: no connection advertises the required capability', { environment_id: environmentId, command, capability })
    return Promise.reject(new StudioRequiredError())
  }

  const id = `cmd-${nextCommandId++}`
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      warn('reverse command timed out', { connection_id: conn.id, command, id, timeout_ms: timeoutMs })
      reject(new Error(`studio command ${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })

    const sent = conn.send({ type: 'studio_command', id, command, args, timeoutMs })
    if (!sent) {
      pending.delete(id)
      clearTimeout(timer)
      reject(new StudioRequiredError())
      return
    }
    log('reverse command routed', { connection_id: conn.id, environment_id: environmentId, command, capability, id })
  })
}

/** TEST ONLY. Clears any pending reverse commands (their timers keep the process alive otherwise). */
export function _resetPendingCommandsForTest(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}
