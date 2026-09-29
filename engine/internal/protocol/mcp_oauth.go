package protocol

// McpOAuthSettings is the operator-configured OAuth client carried by mcp_add
// and mcp_update. Every field is optional: whatever is left empty, the engine
// fills from the server's discovery metadata at login.
//
// On mcp_add an empty or absent block means the server relies on discovery and
// dynamic registration alone. On mcp_update the block replaces the stored
// settings: an empty field removes that setting.
type McpOAuthSettings struct {
	ClientID string `json:"clientId,omitempty"`
	// ClientSecret is set only for a confidential client. On mcp_update, an
	// absent value keeps the stored secret, an empty string removes it, and a
	// value replaces it. The engine never reports a stored secret back.
	ClientSecret *string `json:"clientSecret,omitempty"`
	AuthURL      string  `json:"authUrl,omitempty"`
	TokenURL     string  `json:"tokenUrl,omitempty"`
	Scope        string  `json:"scope,omitempty"`
	// Resource is the RFC 8707 resource indicator sent with the authorization
	// and token requests.
	Resource string `json:"resource,omitempty"`
}
