package mcp

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	mcpgoauth "github.com/modelcontextprotocol/go-sdk/auth"
	"golang.org/x/oauth2"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// sdkOAuthHandler adapts Ion's durable OAuth stores to the SDK transport's
// per-request token and one-shot 401/403 authorization contract.
type sdkOAuthHandler struct {
	resolver *tokenResolver
}

func configuredSDKOAuthHandler(serverName string, config types.McpServerConfig) mcpgoauth.OAuthHandler {
	resolver := configuredTokenResolver(serverName, config)
	if resolver == nil {
		return nil
	}
	return &sdkOAuthHandler{resolver: resolver}
}

func (h *sdkOAuthHandler) TokenSource(context.Context) (oauth2.TokenSource, error) {
	if h == nil || h.resolver == nil {
		return nil, nil
	}
	return oauth2.ReuseTokenSource(nil, tokenSourceFunc(func() (*oauth2.Token, error) {
		value, err := h.resolver.Token()
		if err != nil {
			return nil, err
		}
		parts := strings.SplitN(value, " ", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid authorization value")
		}
		return &oauth2.Token{AccessToken: parts[1], TokenType: parts[0], Expiry: time.Now().Add(time.Hour)}, nil
	})), nil
}

func (h *sdkOAuthHandler) Authorize(_ context.Context, req *http.Request, resp *http.Response) error {
	if resp != nil && resp.Body != nil {
		defer func() {
			if err := resp.Body.Close(); err != nil {
				utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "authorization response close failed", map[string]any{"error": err.Error()})
			}
		}()
	}
	if h == nil || h.resolver == nil || !h.resolver.HasCredentials() {
		return fmt.Errorf("no stored MCP OAuth credentials")
	}
	challengeScope := ""
	if resp != nil {
		challengeScope = ParseBearerScope(resp.Header.Get("WWW-Authenticate"))
	}
	if challengeScope != "" {
		currentScope := ""
		if h.resolver.config != nil {
			currentScope = h.resolver.config.Scope
		}
		requestedScope := AccumulateScopes(currentScope, challengeScope)
		utils.LogWithFields(utils.LevelWarn, "mcp.oauth", "server requires additional authorization scope", map[string]any{"scope": requestedScope, "challengeScope": challengeScope, "status": resp.StatusCode})
		return &ReauthorizationRequiredError{Scope: requestedScope, Challenge: resp.Header.Get("WWW-Authenticate"), Status: resp.StatusCode}
	}
	_, err := h.resolver.ForceRefresh(req.Header.Get("Authorization"))
	return err
}

type tokenSourceFunc func() (*oauth2.Token, error)

func (f tokenSourceFunc) Token() (*oauth2.Token, error) { return f() }
