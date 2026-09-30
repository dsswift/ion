package mcp

import (
	"context"
	"fmt"
	"net/http"

	mcpgo "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/sysmetrics"
	"github.com/dsswift/ion/engine/internal/types"
)

// DiscoveryProtocolVersion remains on discovery requests for legacy gateways. Modern
// protocol version negotiation is owned by the official SDK.
const DiscoveryProtocolVersion = "2026-07-28"

// newSDKTransport selects an official MCP SDK transport plus Ion's HTTP policy
// wrapper. The wrapper is deliberately transport-level: protocol negotiation,
// headers, and request framing stay owned by the SDK.
func newSDKTransport(name string, config types.McpServerConfig) (mcpgo.Transport, func() error, error) {
	switch config.Type {
	case "", "stdio":
		transport, err := commandTransport(config)
		if err != nil {
			return nil, nil, err
		}
		return transport, func() error {
			if p := transport.Command.Process; p != nil {
				sysmetrics.UnregisterProcess(p.Pid)
			}
			return nil
		}, nil
	case "http":
		if config.URL == "" {
			return nil, nil, fmt.Errorf("HTTP transport requires base URL")
		}
		return &mcpgo.StreamableClientTransport{
			Endpoint:     config.URL,
			HTTPClient:   ionMCPHTTPClient(name, config),
			OAuthHandler: configuredSDKOAuthHandler(name, config),
			// Modern servers have no standalone GET stream. The SDK receives
			// request-scoped streams and opens subscriptions/listen itself.
			DisableStandaloneSSE: true,
		}, func() error { return nil }, nil
	case "sse":
		if config.URL == "" {
			return nil, nil, fmt.Errorf("SSE transport requires URL")
		}
		return &mcpgo.SSEClientTransport{Endpoint: config.URL, HTTPClient: ionMCPHTTPClient(name, config)}, func() error { return nil }, nil
	case "ws", "websocket":
		if config.URL == "" {
			return nil, nil, fmt.Errorf("WebSocket transport requires URL")
		}
		client := ionMCPHTTPClient(name, config)
		transport, err := newWSTransport(name, config.URL, client, nil)
		if err != nil {
			return nil, nil, err
		}
		return transport, func() error { return nil }, nil
	default:
		return nil, nil, fmt.Errorf("unsupported MCP transport type: %s", config.Type)
	}
}

// ionMCPHTTPClient clones the shared enterprise client so per-server headers
// never leak to another MCP server. Proxy, CA, TLS and keepalive policy remain
// those configured through internal/network.
func ionMCPHTTPClient(serverName string, config types.McpServerConfig) *http.Client {
	base := *network.GetHTTPClient()
	base.Transport = &mcpHeaderRoundTripper{
		base:       network.GetHTTPClient().Transport,
		serverName: serverName,
		headers:    cloneHeaders(config.Headers),
		oauth:      configuredTokenResolver(serverName, config),
		userToken:  configuredUserToken(config),
	}
	return &base
}

func cloneHeaders(source map[string]string) map[string]string {
	out := make(map[string]string, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func configuredTokenResolver(serverName string, config types.McpServerConfig) *tokenResolver {
	var oauthCfg *OAuthConfig
	if config.OAuth != nil {
		oauthCfg = &OAuthConfig{
			ClientID: config.OAuth.ClientID, ClientSecret: config.OAuth.ClientSecret,
			AuthURL: config.OAuth.AuthURL, TokenURL: config.OAuth.TokenURL,
			Scope: config.OAuth.Scope, RedirectURI: config.OAuth.RedirectURI,
			Resource: config.OAuth.Resource,
		}
	}
	return newTokenResolver(serverName, oauthCfg)
}

// configuredUserToken returns the per-request identity-token resolver for a
// server that opts into forwarding through either ForwardIdentityToken or its
// legacy alias ForwardUserToken, or nil when neither is set.
func configuredUserToken(config types.McpServerConfig) func() (string, error) {
	scope, audience, ok := identityTokenRequest(config)
	if !ok {
		return nil
	}
	return func() (string, error) {
		op := auth.Operator()
		if op == nil {
			return "", fmt.Errorf("identity-token forwarding configured but no identity is available (set auth.identityProvider in engine.json and sign in)")
		}
		return op.GetTokenWithAudience(context.Background(), scope, audience)
	}
}

// identityTokenRequest resolves whether a server forwards the identity token
// and the scope and audience it is minted for. ForwardIdentityToken selects
// the generic IdentityTokenScope and IdentityTokenAudience, empty values
// included, so an operator can pick provider defaults; otherwise the legacy
// UserTokenScope and UserTokenAudience apply.
func identityTokenRequest(config types.McpServerConfig) (scope, audience string, ok bool) {
	switch {
	case config.ForwardIdentityToken:
		return config.IdentityTokenScope, config.IdentityTokenAudience, true
	case config.ForwardUserToken:
		return config.UserTokenScope, config.UserTokenAudience, true
	default:
		return "", "", false
	}
}

type mcpHeaderRoundTripper struct {
	base       http.RoundTripper
	serverName string
	headers    map[string]string
	oauth      *tokenResolver
	userToken  func() (string, error)
}

func (r *mcpHeaderRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	for key, value := range r.headers {
		clone.Header.Set(key, value)
	}
	if r.oauth != nil {
		value, err := r.oauth.Token()
		if err != nil {
			return nil, fmt.Errorf("resolve MCP OAuth token for %s: %w", r.serverName, err)
		}
		clone.Header.Set("Authorization", value)
	}
	if r.userToken != nil {
		token, err := r.userToken()
		if err != nil {
			return nil, fmt.Errorf("resolve operator token for %s: %w", r.serverName, err)
		}
		clone.Header.Set("Authorization", "Bearer "+token)
	}
	base := r.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(clone)
}

// Compile-time check keeps the wrapper honest when Go changes RoundTripper.
var _ http.RoundTripper = (*mcpHeaderRoundTripper)(nil)
