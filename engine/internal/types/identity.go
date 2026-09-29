package types

// SessionPrincipal is the person or service attributed to an engine session.
// A server fronting one engine for many people stamps this on start_session
// (and, per-turn, on send_prompt) so the engine can tell the harness who is
// speaking, attribute a conversation to a person, and filter conversation
// listings to one person's own. The engine never validates Subject against
// any identity provider -- the caller (server, harness) has already done
// that; the engine only carries, stores, and reports what it is told.
//
// Claims is never persisted to disk (see Conversation.Principal, which
// carries only the smaller ConversationPrincipal). It exists purely so a
// hook handler (identity_changed, Context.Identity()) can inspect
// provider-specific claims for the lifetime of one process, without the
// engine writing bearer-adjacent data into a conversation file.
type SessionPrincipal struct {
	// Subject is the stable identifier for this principal: an OIDC "sub"
	// claim, or "local:<os-username>" for a principal minted locally with no
	// identity provider. Required -- validated non-empty when Principal is
	// present at all (see protocol/command_validation.go).
	Subject string `json:"subject"`
	// Provider names the issuer or mechanism that vouched for this
	// principal: "entra", "oidc", "os" (a local OS-derived identity), or any
	// other issuer tag a server assigns. Opaque to the engine.
	Provider string `json:"provider"`
	// Kind is "operator" (a verified human/service identity from an
	// identity provider) or "local" (the local-machine fallback principal).
	Kind string `json:"kind"`
	// Username is the principal's short account name, when known.
	Username string `json:"username,omitempty"`
	// DisplayName is the principal's human-readable name, when known.
	DisplayName string `json:"displayName,omitempty"`
	// Email is the principal's email address, when known (FR-04: git commit
	// author/committer email). Bearer doors populate it from the token's
	// `email` claim, falling back to `preferred_username` when that looks
	// like an address -- `email` is an OPTIONAL claim in Entra v2 tokens.
	Email string `json:"email,omitempty"`
	// Attribution overrides the user value telemetry and ambient logs stamp
	// for this principal (AttributionForTelemetry). Empty when the caller did
	// not supply one.
	Attribution string `json:"attribution,omitempty"`
	// Claims carries provider-specific claims (roles, scopes, tenant, ...)
	// for the lifetime of the process. Never persisted -- see the type
	// doc comment above. Wire and hook consumption only.
	Claims map[string]any `json:"claims,omitempty"`
	// MultiTenant is true when the server fronting this session can attribute
	// sessions to more than one distinct person at once (server/src/config/
	// current.ts's isSharedTenancy() returning false -- an "isolated" install
	// where paired devices are NOT folded to one host identity). False (the
	// zero value) covers both "unknown" -- a caller with no server tenancy
	// concept at all, e.g. a raw CLI-driven engine -- and a confirmed
	// single-person install (isSharedTenancy() true: a personal desktop, or a
	// dedicated instance pod whose owner is the sole principal), so an
	// omitted field preserves single-person behavior rather than defaulting
	// to caution. Only a server that has POSITIVELY determined more than one
	// person shares this engine sets it true. Consumed by
	// promoteSessionPrincipalProcessWide (session/start_session.go) to gate
	// process-wide telemetry identity promotion: per-session events keep
	// their own principal regardless of this flag.
	MultiTenant bool `json:"multiTenant,omitempty"`
}

// ConversationPrincipal is the durable, on-disk attribution stamped on a
// conversation's header at mint. It is intentionally smaller than
// SessionPrincipal: no Claims (never persisted), no Kind (the header does
// not need to distinguish "operator" from "local" -- only who owns it).
type ConversationPrincipal struct {
	Subject     string `json:"subject"`
	Provider    string `json:"provider"`
	DisplayName string `json:"displayName,omitempty"`
}

// ToConversation projects a SessionPrincipal down to the durable header
// shape. Returns nil for a nil receiver so callers can stamp
// `conv.Principal = principal.ToConversation()` unconditionally without a
// nil check at every call site.
func (p *SessionPrincipal) ToConversation() *ConversationPrincipal {
	if p == nil {
		return nil
	}
	return &ConversationPrincipal{
		Subject:     p.Subject,
		Provider:    p.Provider,
		DisplayName: p.DisplayName,
	}
}

// AttributionForTelemetry returns the value telemetry and ambient logs
// stamp for work done on this principal's behalf (FR-05 child 10,
// R-41/R-42): Attribution first, then Username, then DisplayName, then
// Subject. Username before DisplayName is the same order the engine's own
// signed-in identity uses for process-wide attribution
// (auth.OperatorIdentity.AttributionValue: attribution claim, then
// preferred_username, then subject), so one person reads as one user
// whether a line came from their session or from the process. Returns ""
// for a nil receiver or an entirely empty principal, so a caller never
// stamps an empty user string. Deliberately never returns Claims -- Claims
// must never reach telemetry or logs (see the type doc comment above).
func (p *SessionPrincipal) AttributionForTelemetry() string {
	if p == nil {
		return ""
	}
	if p.Attribution != "" {
		return p.Attribution
	}
	if p.Username != "" {
		return p.Username
	}
	if p.DisplayName != "" {
		return p.DisplayName
	}
	return p.Subject
}
