package mcp

// login_caller.go — MCP OAuth login completed by the caller.
//
// The loopback flow (BeginLogin) needs the browser on the engine's host. A
// consumer elsewhere supplies its own redirect URI, catches the provider's
// redirect itself, and returns the callback URL to CompleteCallerLogin. Between
// the two calls the engine holds the PKCE verifier, state, client, and redirect
// in a pending entry keyed by server name.

import (
	"errors"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CallerLoginTTL bounds how long a caller-completed login waits for its
// callback.
const CallerLoginTTL = 10 * time.Minute

type pendingCallerLogin struct {
	reg       *ClientRegistration
	authz     *auth.PKCEAuthorization
	expiresAt time.Time
}

var (
	pendingCallerLoginsMu sync.Mutex
	pendingCallerLogins   = map[string]*pendingCallerLogin{}
	// callerLoginNow is the clock for pending-login expiry; tests replace it.
	callerLoginNow = time.Now
)

// BeginCallerLogin starts an OAuth login whose redirect lands at redirectURI,
// which the caller owns. No listener is started. The returned authorization URL
// is opened by the caller; the callback URL the provider redirects to is handed
// to CompleteCallerLogin within CallerLoginTTL. A new begin for the same server
// replaces any earlier pending login.
func BeginCallerLogin(serverName string, cfg types.McpServerConfig, scopeOverride, redirectURI string) (string, error) {
	if redirectURI == "" {
		return "", fmt.Errorf("mcp login %s: caller-completed login requires a redirect uri", serverName)
	}
	invalidateDiscovery(cfg.URL, "")

	reg, err := ResolveClient(serverName, cfg, scopeOverride, redirectURI)
	if err != nil {
		return "", err
	}
	if reg.AuthURL == "" || reg.TokenURL == "" {
		return "", fmt.Errorf("mcp login %s: resolved client has no authorization/token endpoint", serverName)
	}
	if reg.RedirectURI != "" && reg.RedirectURI != redirectURI {
		// Only an operator-configured client reaches here; the provider may
		// reject a redirect it does not have on file, and the caller asked for
		// this one explicitly.
		utils.LogWithFields(utils.LevelWarn, "mcp.login", "caller redirect differs from the client's configured redirect", map[string]any{
			"serverName": serverName, "configuredRedirectUri": reg.RedirectURI, "redirectUri": redirectURI,
		})
	}

	authz, err := auth.BeginPKCEAuthorization(pkceConfigFor(reg), redirectURI)
	if err != nil {
		return "", fmt.Errorf("mcp login %s: %w", serverName, err)
	}

	now := callerLoginNow()
	pendingCallerLoginsMu.Lock()
	for name, p := range pendingCallerLogins {
		if now.After(p.expiresAt) {
			delete(pendingCallerLogins, name)
			utils.LogWithFields(utils.LevelInfo, "mcp.login", "expired caller login dropped", map[string]any{"serverName": name})
		}
	}
	_, replaced := pendingCallerLogins[serverName]
	pendingCallerLogins[serverName] = &pendingCallerLogin{reg: reg, authz: authz, expiresAt: now.Add(CallerLoginTTL)}
	pendingCallerLoginsMu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "mcp.login", "caller-completed login started", map[string]any{
		"serverName": serverName, "clientId": reg.ClientID, "authUrl": reg.AuthURL,
		"scope": reg.Scope, "redirectUri": redirectURI, "replacedPending": replaced,
	})
	return authz.AuthorizationURL, nil
}

// CompleteCallerLogin finishes a login started by BeginCallerLogin with the
// URL the provider redirected to. The pending login is consumed by the attempt
// whatever its outcome, so a callback cannot be replayed or guessed at.
func CompleteCallerLogin(serverName, callbackURL string) error {
	pendingCallerLoginsMu.Lock()
	pending, ok := pendingCallerLogins[serverName]
	delete(pendingCallerLogins, serverName)
	pendingCallerLoginsMu.Unlock()

	if !ok {
		utils.LogWithFields(utils.LevelInfo, "mcp.login", "caller login completion rejected: nothing pending", map[string]any{"serverName": serverName})
		return fmt.Errorf("mcp login %s: no sign-in is pending for this server; start it again", serverName)
	}
	if callerLoginNow().After(pending.expiresAt) {
		utils.LogWithFields(utils.LevelInfo, "mcp.login", "caller login completion rejected: expired", map[string]any{
			"serverName": serverName, "expiredAt": pending.expiresAt.Format(time.RFC3339),
		})
		return fmt.Errorf("mcp login %s: the sign-in expired after %s; start it again", serverName, CallerLoginTTL)
	}

	parsed, err := url.Parse(callbackURL)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "mcp.login", "caller login completion rejected: unparseable callback", map[string]any{
			"serverName": serverName, "error": err.Error(),
		})
		return fmt.Errorf("mcp login %s: callback url is not a url: %w", serverName, err)
	}

	tok, err := pending.authz.Complete(parsed.Query())
	if err != nil {
		reason := "exchange-failed"
		var rejection *auth.CallbackError
		if errors.As(err, &rejection) {
			reason = rejection.Reason
		}
		utils.LogWithFields(utils.LevelError, "mcp.login", "caller login did not complete", map[string]any{
			"serverName": serverName, "reason": reason, "error": err.Error(),
		})
		return fmt.Errorf("mcp login %s: %w", serverName, err)
	}

	finishLogin(serverName, pending.reg, tok, "caller")
	return nil
}
