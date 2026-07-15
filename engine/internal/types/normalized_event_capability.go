package types

// CapabilityUnsupportedEvent is emitted when a requested feature is not
// supported by the backend that would serve the run, and the engine declined
// the request cleanly instead of dispatching a run that would fail (e.g.
// plan mode on a backend without a plan/architect mode).
//
// The engine reports; the consumer decides. A harness may reroute the prompt
// to a capable model, abort, notify the user, or ignore the event — the
// engine has no opinion and never auto-reroutes (that would be a policy
// lock-in). Per CLAUDE.md § "The typed-event corollary", this typed event is
// the engine's complete signaling surface for the declined request: no run
// starts, no stream content is synthesized, and the session stays idle and
// immediately usable for the next prompt.
//
// Workflow signal, not a state snapshot. It fires once at the decline site
// and is not replayed on reconnect.
type CapabilityUnsupportedEvent struct {
	// Capability is the machine-readable name of the unsupported feature
	// ("plan_mode" today; the vocabulary grows with the capability
	// contract — see backend.BackendCapabilities).
	Capability string `json:"capability"`
	// Backend is the routing kind of the backend that would have served the
	// run ("grok", "cursor", "codex", "claude-code", "api").
	Backend string `json:"backend"`
	// Reason is a human-readable explanation suitable for direct display.
	Reason string `json:"reason"`
}

func (CapabilityUnsupportedEvent) eventType() string { return EventCapabilityUnsupported }
