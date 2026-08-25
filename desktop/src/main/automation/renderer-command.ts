import { randomUUID } from 'crypto'
import { state } from '../state'
import { error, log, warn } from '../logger'
import type { AutomationAction } from '../../shared/types-automation'

const TAG = 'automation.renderer_command'
const TIMEOUT_MS = 15_000

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
 * Sends a finite, validated command through preload to the owner renderer.
 * Renderer replies through `resolveAutomationRendererCommand`; no action is
 * performed through injected JavaScript or an unacknowledged fire-and-forget.
 */
export function runAutomationRendererCommand(action: AutomationAction): Promise<void> {
  const window = state.mainWindow
  if (!window || window.isDestroyed()) {
    return Promise.reject(new Error('Automation renderer command requires an available owner renderer'))
  }

  const id = randomUUID()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Automation renderer command timed out: ${action.kind}`))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    window.webContents.send('ion:automation-command', { id, action } satisfies AutomationRendererCommand)
    log(TAG, 'automation renderer command sent', { command_id: id, kind: action.kind })
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
