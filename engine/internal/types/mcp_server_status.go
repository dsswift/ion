package types

// mcp_server_status.go — the wire shape describing one configured MCP server.

// McpServerStatus reports one configured MCP server and what the engine
// currently knows about it. Carried by the engine_mcp_servers event, which is a
// complete snapshot: consumers replace their local view with the full slice.
// Tracked by contract sync.
//
// Connected and Authenticated are deliberately independent. A server can be
// connected without authentication (it requires none), authenticated but not
// connected (a token is stored and the last connect attempt still failed), or
// neither. Collapsing them into one "ok" flag would hide exactly the state an
// operator needs to act on: a stored token that is not getting them in.
type McpServerStatus struct {
	// Name is the key under engine.json's mcpServers map.
	Name string `json:"name"`
	// Transport is the configured transport: "http", "sse", "ws", or "stdio".
	Transport string `json:"transport,omitempty"`
	// URL is the endpoint for a network transport; empty for stdio.
	URL string `json:"url,omitempty"`
	// Command is the executable for a stdio server; empty for network
	// transports.
	Command string `json:"command,omitempty"`
	// Connected reports whether at least one live session currently holds a
	// connection to this server.
	Connected bool `json:"connected"`
	// Authenticated reports whether a usable (unexpired) OAuth token is stored
	// for this server. False for a server that needs no authentication, which
	// is why it must be read alongside Connected rather than on its own.
	Authenticated bool `json:"authenticated"`
	// ToolCount is how many tools the live connection exposed. Zero when not
	// connected.
	ToolCount int `json:"toolCount,omitempty"`
	// ProtocolVersion is the negotiated MCP revision of the live connection.
	ProtocolVersion string `json:"protocolVersion,omitempty"`
	// Capabilities names server capability and extension identifiers advertised
	// by the live connection. Sorted by the session manager for stable snapshots.
	Capabilities []string `json:"capabilities,omitempty"`
	// LastError is the most recent connection failure for this server, empty
	// when the last attempt succeeded or none has been made. This is the field
	// that makes a failing server diagnosable from a client with no access to
	// the engine host's log file.
	LastError string `json:"lastError,omitempty"`
}
