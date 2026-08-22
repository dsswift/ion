/**
 * engine-bridge-log-correlation — teach the logger which conversation a
 * session key belongs to.
 *
 * The bridge's `activeSessions` map is the authoritative
 * `engine session key -> conversationId` binding: it is written when a session
 * starts, updated by `updateSessionConversationId`, and is what the reconnect
 * path restores from. The logger needs exactly that mapping to stamp each line
 * with the conversation the line is actually about (see log-correlation.ts for
 * why per-line resolution replaced a single process-wide session context).
 *
 * This lives in its own module rather than inline in the bridge constructor for
 * two reasons: the bridge file is at its size cap, and the direction of the
 * dependency matters — the logger must never import the bridge (the bridge
 * logs, so that would be a require cycle). Installing the resolver from the
 * bridge side keeps the arrow pointing one way.
 */
import { setConversationResolver } from "./log-correlation";

/** The bridge surface this installer reads. Structural, to avoid a type cycle. */
interface SessionRegistry {
  activeSessions: Map<string, { conversationId?: string }>;
  /** Client-side key aliases: oldKey → newKey. Private on the bridge itself. */
  keyAliases?: Map<string, string>;
}

/**
 * Point the logger's correlation lookup at this bridge's session registry.
 * Called once from the bridge constructor.
 */
export function installLogCorrelation(bridge: SessionRegistry): void {
  setConversationResolver((key) => {
    const direct = bridge.activeSessions.get(key)?.conversationId;
    if (direct) return direct;
    // The alias hop is not optional: remapSession MOVES the activeSessions
    // entry to the new key, so a line logged against the OLD key would resolve
    // to nothing. Incoming events already route through keyAliases for exactly
    // this reason (see the bridge's _handleMessage); correlation takes the same
    // path so a remap cannot silently strip conversation_id off live lines.
    const aliased = bridge.keyAliases?.get(key);
    return aliased ? bridge.activeSessions.get(aliased)?.conversationId : undefined;
  });
}
