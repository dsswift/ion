package types

// PolicyOverrideReason is a stable, machine-readable code saying which
// enterprise rule displaced a lower-layer value. A consumer maps it to its own
// presentation text; the engine ships none.
type PolicyOverrideReason string

const (
	// PolicyOverrideProviderPinned: an enterprise provider definition replaced
	// one field of the lower-layer definition for the same provider key.
	PolicyOverrideProviderPinned PolicyOverrideReason = "managed_provider_pinned"
	// PolicyOverrideProviderNotAllowed: a lower-layer provider was removed
	// because the enterprise provider allowlist does not name it.
	PolicyOverrideProviderNotAllowed PolicyOverrideReason = "provider_not_allowed"
	// PolicyOverrideModelNotAllowed: the lower-layer default model was
	// replaced because the enterprise model allowlist does not name it.
	PolicyOverrideModelNotAllowed PolicyOverrideReason = "model_not_allowed"
	// PolicyOverrideModelBlocked: the lower-layer default model was replaced
	// because the enterprise model blocklist names it.
	PolicyOverrideModelBlocked PolicyOverrideReason = "model_blocked"
	// PolicyOverrideMcpServerDenied: a lower-layer MCP server was removed
	// because the enterprise MCP denylist names it.
	PolicyOverrideMcpServerDenied PolicyOverrideReason = "mcp_server_denied"
	// PolicyOverrideMcpServerNotAllowed: a lower-layer MCP server was removed
	// because the enterprise MCP allowlist does not admit it.
	PolicyOverrideMcpServerNotAllowed PolicyOverrideReason = "mcp_server_not_allowed"
)

// PolicyOverride records one lower-layer (user or project) config value that
// enterprise enforcement replaced or removed. It exists only when the value in
// effect differs from the one the lower layer supplied: a lower-layer value
// equal to the policy value is not an override.
type PolicyOverride struct {
	// Field is the config path of the displaced value, in engine.json key
	// spelling: "providers.<key>.baseURL", "providers.<key>", "defaultModel",
	// "mcpServers.<key>".
	Field  string               `json:"field"`
	Reason PolicyOverrideReason `json:"reason"`
	// UserValue is the lower-layer value that is not in effect. Omitted for a
	// removed entry and for any field that can hold a secret.
	UserValue string `json:"userValue,omitempty"`
	// EffectiveValue is the value in effect instead. Omitted when the value
	// was removed outright and for any field that can hold a secret.
	EffectiveValue string `json:"effectiveValue,omitempty"`
}
