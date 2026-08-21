/**
 * log-correlation — resolve a log line's `session_id` / `conversation_id` from
 * the line ITSELF, rather than from ambient "current session" state.
 *
 * ─── Why this module exists ─────────────────────────────────────────────────
 *
 * The logger used to carry one module-level `sessionContext`, stamped by
 * `setSessionContext` on the ENSURE_ENGINE_SESSION path. That is a single
 * global for a process that runs MANY conversations at once: the desktop
 * restores every tab on launch and each one ensures its engine session, so the
 * last tab to start overwrote the stamp for every line the process wrote
 * afterwards — including lines emitted on behalf of entirely different
 * conversations.
 *
 * The observable damage was not cosmetic. It broke the documented contract in
 * `docs/observability/log-schema.md`: `conversation_id` is "the durable
 * identity of the persisted conversation tree", and the whole point of the
 * documented `jq`/LogQL recipes ("filter one conversation") is that filtering
 * by it yields that conversation's lines. With one shared global, a filter
 * returned a mix — some lines belonging to the named conversation, many
 * belonging to whichever tab happened to start last — and, worse, silently
 * OMITTED real lines for the conversation being investigated because they were
 * stamped with a neighbour's ID. An investigator cannot tell the two apart, so
 * the field was not merely noisy, it was actively misleading.
 *
 * ─── The resolution rule ────────────────────────────────────────────────────
 *
 * Nearly every desktop log line already names its own subject in `fields`: the
 * engine session key (`key`) or the tab id (`tab_id`) — the two are the same
 * identifier, since the desktop uses the tab UUID as the engine session key
 * (see the `session_id` row of the log-schema table). A caller that knows the
 * conversation states it directly as `conversation_id`.
 *
 * So a line's identity is derived, in order:
 *
 *   1. An explicit `conversation_id` / `session_id` field wins outright. The
 *      caller knew the answer; never second-guess it.
 *   2. Otherwise the subject key (`key` or `tab_id`) becomes `session_id`, and
 *      the conversation is looked up from the live session registry that
 *      already tracks `key -> conversationId` (engine-bridge's activeSessions,
 *      injected here as a resolver to keep this module dependency-free).
 *   3. Otherwise the line carries NO correlation IDs. Per the schema's
 *      empty-string rule the keys are omitted entirely, never emitted as "".
 *
 * Absent is the correct answer for a genuinely process-wide line (rotation,
 * relay transport, git watcher heartbeats). Those lines belong to no
 * conversation, and stamping them with an arbitrary one is exactly the defect
 * this module removes.
 */

/** The subset of a log line this module reads to decide identity. */
export interface CorrelationInput {
  fields?: Record<string, unknown>;
}

/** Correlation IDs for one line. A key is present only when it is known. */
export interface Correlation {
  session_id?: string;
  conversation_id?: string;
}

/**
 * Looks up the conversation a given engine session key is currently bound to.
 * Returns undefined when the key is unknown or carries no conversation yet.
 */
export type ConversationResolver = (sessionKey: string) => string | undefined;

let resolveConversation: ConversationResolver | null = null;

/**
 * Install the live `key -> conversationId` lookup. Called once at startup with
 * engine-bridge's session registry, which is already the authoritative owner of
 * that mapping (it is what the reconnect path restores from).
 *
 * Injected rather than imported so the logger keeps no dependency on the engine
 * bridge — the bridge logs, and a direct import would be a require cycle.
 */
export function setConversationResolver(resolver: ConversationResolver | null): void {
  resolveConversation = resolver;
}

/** Read a field as a non-empty string, or undefined. Blank strings are not IDs. */
function str(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = fields?.[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Callers routinely pass a placeholder for "not applicable" (the
  // ensure_engine_session handler logs `conversation_id: 'none'`). A
  // placeholder is the absence of an ID, not an ID.
  if (!trimmed || trimmed === "none" || trimmed === "unknown") return undefined;
  return trimmed;
}

/**
 * Resolve one line's correlation IDs. Pure apart from the injected resolver,
 * and never throws: logging must not be able to fail the operation it observes.
 */
export function correlate(input: CorrelationInput): Correlation {
  const { fields } = input;

  // (1) An explicit conversation_id from the caller is authoritative.
  const explicitConversation = str(fields, "conversation_id");

  // The desktop's engine session key IS the tab id, so either field names the
  // same subject. An explicit session_id wins over the inferred subject.
  const sessionId =
    str(fields, "session_id") ?? str(fields, "key") ?? str(fields, "tab_id");

  const result: Correlation = {};
  if (sessionId) result.session_id = sessionId;

  if (explicitConversation) {
    result.conversation_id = explicitConversation;
    return result;
  }

  // (2) Derive the conversation from the subject via the live registry.
  if (sessionId && resolveConversation) {
    try {
      const found = resolveConversation(sessionId);
      const trimmed = typeof found === "string" ? found.trim() : "";
      if (trimmed) result.conversation_id = trimmed;
    } catch {
      // A resolver fault must never break logging, and it has nothing to log
      // itself through (that would recurse). The line simply goes out without a
      // conversation_id, which the schema's empty-string rule already covers as
      // "not in scope" — strictly better than stamping a wrong ID.
      // silent-ok: resolver fault degrades to an absent optional field
    }
  }

  // (3) No subject: the keys stay absent (never "").
  return result;
}

/**
 * TEST ONLY. Drop the installed resolver so cases do not leak into each other.
 */
export function _resetForTest(): void {
  resolveConversation = null;
}
