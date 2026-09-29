/**
 * The main -> Studio-renderer command seam for browser tools, mirroring
 * `studio-graph/renderer-bridge.ts`'s shape exactly.
 *
 * The full browser-tool engine (Playwright-style page automation driving an
 * embedded `BrowserView`) still lives entirely in
 * `desktop/src/main/studio-playwright/` -- only the tool contracts
 * (`tool-contracts.ts`) moved to `server/`. This file exists so
 * `server/src/protocol/listener.ts` has a capability-`browser` seam to wire
 * `commands.send(...)` into (manifest contract C3: reverse `browser.*`
 * commands route to the connection advertising the `browser` capability),
 * exactly parallel to the graph seam. It has no in-`server/` caller yet --
 * the tool executor that would call `browserCommandSender()` is the
 * still-desktop-only code in `desktop/src/main/studio-playwright/tools*.ts`,
 * which is a separate migration from this child's Studio wire scope.
 */
import type { StudioBrowserCommand, StudioBrowserCommandResult } from '@ion/shared/studio-browser-types'

export type BrowserCommandSender = (command: StudioBrowserCommand, timeoutMs: number) => Promise<StudioBrowserCommandResult>

let sender: BrowserCommandSender | null = null

/** Install (or clear, with null) the live Studio renderer browser-command sender. */
export function setBrowserCommandSender(next: BrowserCommandSender | null): void {
  sender = next
}

export function browserCommandSender(): BrowserCommandSender | null {
  return sender
}
