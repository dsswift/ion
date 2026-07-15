package extension

// host_session_binding.go — session/conversation correlation binding for the
// extension Host.
//
// When a Host is loaded for a session, the session manager binds the session
// and conversation IDs here. The JSON-RPC "log" notification handler
// (host_rpc.go) reads them via getBoundIDs so every extension-component log
// line is stamped with the correlating session_id/conversation_id, matching
// the unified log schema. Kept out of the allowlisted god file host.go per the
// file-organization rule (new code → new file in the same package).

// BindSession records the session and conversation IDs for this host.
// Called by the session manager when the extension is loaded for a session.
// Safe to call again (e.g. on respawn) to refresh the binding.
func (h *Host) BindSession(sessionID, conversationID string) {
	h.boundMu.Lock()
	h.boundSessionID = sessionID
	h.boundConversationID = conversationID
	h.boundMu.Unlock()
}

// getBoundIDs returns the session and conversation IDs bound to this host, or
// empty strings when the host has not been bound to a session.
func (h *Host) getBoundIDs() (sessionID, conversationID string) {
	h.boundMu.RLock()
	sessionID = h.boundSessionID
	conversationID = h.boundConversationID
	h.boundMu.RUnlock()
	return
}
