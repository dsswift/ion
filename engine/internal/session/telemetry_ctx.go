package session

// correlationCtx builds the canonical telemetry correlation context map used
// by every telemetry emission site in the session package. It ensures that
// run.complete and cache.savings always carry both identifiers so forensic
// queries (Session Summary joins, per-session cost roll-ups) can correlate
// events across subsystems without ambiguity.
//
// Rules:
//   - sessionKey is the engine session key (the value returned by
//     Manager.keyForRun / the key under which Manager.sessions is stored).
//   - conversationID is the durable conversation ID bound to the session
//     (s.conversationID). It may be empty when a session has no conversation
//     (rare, but nil-safe: the key is omitted when empty).
//
// This is the single source of truth for the {"session_id", "conversation_id"}
// pair. All new telemetry call sites in this package should use this builder
// instead of hand-rolling the map literal. For call sites inside an active run
// that have the run_id available, use buildTelemCtx(run) from the backend
// package instead (which also stamps "run_id").
func correlationCtx(sessionKey, conversationID string) map[string]any {
	ctx := map[string]any{
		"session_id": sessionKey,
	}
	if conversationID != "" {
		ctx["conversation_id"] = conversationID
	}
	return ctx
}

// correlationCtxExt extends correlationCtx with optional extension attribution
// fields. When extName is non-empty, "extension" is added to the context map;
// when extVersion is also non-empty, "extension_version" is added. Both fields
// are omit-when-empty (absent from old lines — those group as "unattributed"
// in dashboards). This is the first exercised additive evolution of the
// telemetry context under ADR-019: no schema bump, backward-compatible.
//
// Use this builder (instead of correlationCtx) at every session-package
// cost-bearing emission site that has access to s.extensionName /
// s.extensionVersion (run.complete, cache.savings).
func correlationCtxExt(sessionKey, conversationID, extName, extVersion string) map[string]any {
	ctx := correlationCtx(sessionKey, conversationID)
	if extName != "" {
		ctx["extension"] = extName
		if extVersion != "" {
			ctx["extension_version"] = extVersion
		}
	}
	return ctx
}
