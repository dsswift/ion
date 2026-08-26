/**
 * The main → Studio-renderer command seam for browser tabs.
 *
 * Main owns the Playwright runtime; it does NOT own Surface descriptors. The
 * renderer owns those, so every structural change (create the Agent-linked tab,
 * close it, reveal it, record an emulation change) is a request the renderer
 * applies and acknowledges. Keeping it a request rather than a direct mutation
 * is what lets the renderer answer only once the descriptor is updated AND the
 * matching webview has registered — so a tool call never races a half-mounted
 * guest.
 *
 * The sender is injected rather than imported to keep this module free of
 * Electron: the IPC layer registers the real one at window creation, and tests
 * install a fake. When nothing is registered, callers get `null` and must
 * surface a model-visible "Studio required" error rather than pretending the
 * call succeeded.
 */
import type { StudioBrowserCommand, StudioBrowserCommandResult } from '../../shared/studio-browser-types'

export type BrowserCommandSender = (command: StudioBrowserCommand, timeoutMs: number) => Promise<StudioBrowserCommandResult>

let sender: BrowserCommandSender | null = null

/** Install (or clear, with null) the live Studio renderer command sender. */
export function setBrowserCommandSender(next: BrowserCommandSender | null): void {
  sender = next
}

export function browserCommandSender(): BrowserCommandSender | null {
  return sender
}
