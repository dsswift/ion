/**
 * Bridged `host.shell` verbs, events domain: every one is served by a
 * `studio_action` or `studio_event` on every host (`browser-shell-bridge.ts`),
 * so the Electron preload no longer carries it. Moved verbatim from the
 * preload's `ionapi-events.ts` (spec 12: `IonAPI` shrinks toward the natives and the
 * host relay, `ShellApi` keeps the full surface).
 */
import type { NormalizedEvent } from "@ion/shared/types";

export interface BridgedEventsShell {
  /**
   * The normalized engine-event stream. Served by the bridged shell
   * (`browser-shell-bridge.ts`, channel `ion:normalized-event`) on every
   * host, not by the preload: the frames come from the Studio server.
   */
  onEvent(
    callback: (tabId: string, event: NormalizedEvent) => void,
  ): () => void;
}
