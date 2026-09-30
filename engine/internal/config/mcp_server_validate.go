package config

// mcp_server_validate.go — the rules an mcpServers entry must satisfy before
// the engine writes it. Shared by add and update so both refuse the same
// definitions with the same reasons.

import (
	"fmt"
	"net/url"

	"github.com/dsswift/ion/engine/internal/secretref"
	"github.com/dsswift/ion/engine/internal/types"
)

// NormalizeMcpServerConfig resolves an empty transport and checks the entry is
// internally consistent.
//
// The transport default is inferred rather than required: a URL means a network
// server and a command means stdio. "http" (StreamableHTTP) is the default for a
// URL because it is the current MCP transport; sse is selected explicitly.
func NormalizeMcpServerConfig(cfg *types.McpServerConfig) error {
	if cfg.Type == "" {
		switch {
		case cfg.URL != "":
			cfg.Type = "http"
		case cfg.Command != "":
			cfg.Type = "stdio"
		default:
			return fmt.Errorf("an MCP server needs either a url (http/sse/ws) or a command (stdio)")
		}
	}

	switch cfg.Type {
	case "http", "sse", "ws", "websocket":
		if cfg.URL == "" {
			return fmt.Errorf("transport %q requires a url", cfg.Type)
		}
		if cfg.Command != "" {
			return fmt.Errorf("transport %q takes a url, not a command", cfg.Type)
		}
	case "stdio":
		if cfg.Command == "" {
			return fmt.Errorf("transport \"stdio\" requires a command")
		}
		if cfg.URL != "" {
			return fmt.Errorf("transport \"stdio\" takes a command, not a url")
		}
	default:
		return fmt.Errorf("unsupported MCP transport %q (want http, sse, ws, or stdio)", cfg.Type)
	}

	if err := validateMcpSecretHeaders(cfg); err != nil {
		return err
	}
	return validateMcpOAuth(cfg.OAuth)
}

// validateMcpSecretHeaders checks each secret header's reference. A stdio
// server sends no HTTP headers, so it may not declare any.
func validateMcpSecretHeaders(cfg *types.McpServerConfig) error {
	if len(cfg.SecretHeaders) == 0 {
		return nil
	}
	if cfg.Type == "stdio" {
		return fmt.Errorf("secretHeaders need a network transport, not stdio")
	}
	for name, header := range cfg.SecretHeaders {
		if name == "" {
			return fmt.Errorf("secretHeaders has an empty header name")
		}
		if err := secretref.Validate(header.SecretReference); err != nil {
			return fmt.Errorf("secretHeaders[%s]: %w", name, err)
		}
	}
	return nil
}

// validateMcpOAuth checks an explicit oauth block. Every field is optional:
// what the block leaves empty, discovery fills at login. The one hard rule is
// that endpoints and a secret belong to a client, so they need its client_id.
func validateMcpOAuth(oauth *types.McpOAuthConfig) error {
	if oauth == nil {
		return nil
	}
	if oauth.ClientID == "" && (oauth.ClientSecret != "" || oauth.AuthURL != "" || oauth.TokenURL != "") {
		return fmt.Errorf("oauth client_id is required when a client secret, authorization URL, or token URL is set")
	}
	for field, value := range map[string]string{"auth_url": oauth.AuthURL, "token_url": oauth.TokenURL} {
		if value == "" {
			continue
		}
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
			return fmt.Errorf("oauth %s must be an absolute http(s) URL, got %q", field, value)
		}
	}
	return nil
}
