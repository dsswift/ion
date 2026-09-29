import { randomUUID } from 'crypto'
import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
import { log, warn, error } from '../logger'
import type { AutomationAction } from '@ion/shared/types-automation'

const TAG = 'automation.renderer_command'

export interface AutomationRendererCommand {
  id: string
  action: AutomationAction
}

type PendingCommand = {
  resolve: () => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingCommand>()

/**
 * How long a client has to run the command before it is treated as failed.
 * Long enough for a confirmation dialog a person actually reads; short
 * enough that a client that navigated away does not hang the automation.
 */
const COMMAND_TIMEOUT_MS = 120_000

/**
 * Sends a finite, validated command to an attached client for UI-mediated
 * execution (e.g. a confirmation dialog).
 *
 * The command is broadcast on `ion:automation-command`, which the wire
 * contract fans to every attached Studio connection, and settled by
 * `resolveAutomationRendererCommand` when one of them reports back. Whoever
 * answers first wins; the losers' results are ignored with a log line rather
 * than throwing.
 *
 * A rejection here is a real outcome the automation sees: no client attached
 * (the broadcast reaches nobody and the timeout fires), the client refused,
 * or the client failed. It is never a silent no-op.
 */
export function runAutomationRendererCommand(action: AutomationAction): Promise<void> {
  const id = randomUUID()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      error(TAG, 'automation renderer command timed out', { command_id: id, kind: action.kind, timeout_ms: COMMAND_TIMEOUT_MS })
      reject(new Error('No Studio client ran this automation command before it timed out'))
    }, COMMAND_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    log(TAG, 'automation renderer command dispatched', { command_id: id, kind: action.kind })
    broadcast(IPC.AUTOMATION_COMMAND, { id, action } satisfies AutomationRendererCommand)
  })
}


export function resolveAutomationRendererCommand(id: string, result: { ok: boolean; error?: string }): void {
  const command = pending.get(id)
  if (!command) {
    warn(TAG, 'automation renderer command result ignored', { command_id: id })
    return
  }
  pending.delete(id)
  clearTimeout(command.timer)
  if (result.ok) {
    command.resolve()
    log(TAG, 'automation renderer command succeeded', { command_id: id })
    return
  }
  const message = result.error || 'Renderer rejected automation command'
  command.reject(new Error(message))
  error(TAG, 'automation renderer command failed', { command_id: id, error: message })
}

export function resetAutomationRendererCommandsForTests(): void {
  for (const [id, command] of pending) {
    clearTimeout(command.timer)
    command.reject(new Error('Automation renderer command reset'))
    pending.delete(id)
  }
}
