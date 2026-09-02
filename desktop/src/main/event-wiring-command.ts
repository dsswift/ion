import type { NormalizedEvent } from "../shared/types";
import { tabIdFromKey } from "../shared/session-key";

export function handleCommandEvent(
  key: string,
  event: any,
  broadcastNormalized: (tabId: string, event: NormalizedEvent) => void,
): boolean {
  const tabId = tabIdFromKey(key);
  if (event.type === "engine_command_registry") {
    broadcastNormalized(tabId, {
      type: "command_registry",
      commands: Array.isArray(event.commands) ? event.commands : [],
    });
    return true;
  }
  if (event.type !== "engine_command_result") return false;
  broadcastNormalized(tabId, {
    type: "command_result",
    command: event.command,
    commandError: event.commandError,
  });
  return true;
}
