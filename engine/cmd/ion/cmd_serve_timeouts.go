package main

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
)

// configureSubsystemTimeouts installs process-wide defaults after config merge.
// MCP now uses SDK stdio, Streamable HTTP, and SSE transports; the retired
// WebSocket-only mcpWriteMs setting has no active transport write deadline.
func configureSubsystemTimeouts(timeouts *types.TimeoutsConfig) {
	if timeouts == nil {
		return
	}
	mcp.SetDefaultCallTimeout(timeouts.McpCall())
	mcp.SetDefaultMetadataTimeout(timeouts.McpMetadata())
	extension.ConfiguredDefaultTimeout = timeouts.HookDefault()
}
