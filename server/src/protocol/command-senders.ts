/**
 * Wires the two existing reverse-command seams (`studio-graph/renderer-bridge.ts`,
 * `studio-playwright/renderer-bridge.ts`) to the Studio wire's `commands.send`
 * (manifest contract C3, Relevant Files: "sender = `commands.send(environmentId, …)`").
 *
 * Both seams are generic injection points ("the sender is injected rather
 * than imported... the IPC layer registers the real one at window creation")
 * -- this module is the Studio wire's registration, parallel to the
 * desktop's own `main/ipc/studio-graph.ts` registering an in-process
 * Electron IPC sender for its own (non-wire) Studio window. A process can
 * only usefully register one or the other: the standalone headless server
 * (`main.ts`, via `startStudioListeners`) registers this wire-backed sender;
 * the desktop app registers its own IPC-backed one instead and never calls
 * `startStudioListeners`.
 */
import type { StudioGraphCommand, StudioGraphCommandResult } from '@ion/shared/studio-graph-types'
import type { StudioBrowserCommand, StudioBrowserCommandResult } from '@ion/shared/studio-browser-types'
import { setGraphCommandSender } from '../studio-graph/renderer-bridge'
import { setBrowserCommandSender } from '../studio-playwright/renderer-bridge'
import { BROWSER_TOOL_COMMAND_TIMEOUT_MS, setBrowserToolExecutor } from '../studio-playwright/tool-executor'
import type { BrowserToolResult } from '../studio-playwright/tool-contracts'
import { send } from './commands'
import { connectionRegistry } from './connection'

/** Install both reverse-command senders against `environmentId`. Idempotent -- re-registers the same functions. */
export function installStudioCommandSenders(environmentId: string): void {
  setGraphCommandSender((command: StudioGraphCommand, timeoutMs: number) =>
    send(connectionRegistry, environmentId, `graph.${command.kind}`, command, timeoutMs) as Promise<StudioGraphCommandResult>,
  )
  setBrowserCommandSender((command: StudioBrowserCommand, timeoutMs: number) =>
    send(connectionRegistry, environmentId, `browser.${command.kind}`, command, timeoutMs) as Promise<StudioBrowserCommandResult>,
  )
  // A browser TOOL call (as opposed to a renderer surface command) goes to
  // the attached desktop, which runs the Playwright body and answers with
  // the tool result. Same capability, same route; a different consumer on
  // the same connection answers it (the desktop main process, not the
  // renderer).
  setBrowserToolExecutor((name, input, ctx) =>
    send(connectionRegistry, environmentId, 'browser.tool', { name, input, ctx }, BROWSER_TOOL_COMMAND_TIMEOUT_MS) as Promise<BrowserToolResult>,
  )
}

/** TEST ONLY. Clears both senders. */
export function _clearStudioCommandSendersForTest(): void {
  setGraphCommandSender(null)
  setBrowserCommandSender(null)
  setBrowserToolExecutor(null)
}
