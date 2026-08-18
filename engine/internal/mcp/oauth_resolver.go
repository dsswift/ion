package mcp

// oauth_resolver.go — per-request OAuth token resolution for long-lived
// connections.
//
// A connection outlives its access token. Mobbin's tokens last an hour; a
// conversation open longer than that was sending a stale Authorization header
// until it reconnected, and the server answered 401 on every tool call. The
// stored refresh token was never used, because the header was resolved once at
// Connect and then frozen into the transport.
//
// The operator-token path (config.forwardUserToken) already got this right — it
// resolves on EVERY request specifically because "a connect-time token would
// expire mid-session". This file gives the OAuth path the same property, so the
// two behave consistently instead of one silently degrading after an hour.
//
// Two mechanisms, both needed:
//
//   - tokenResolver: returns the current token per request, refreshing when it
//     is at or near expiry. Handles the ordinary case without any failed
//     request.
//   - ForceRefresh: discards the cached token and refreshes unconditionally.
//     Drives the 401 retry, for when the provider rejects a token the engine
//     still believes is valid (revoked, rotated, or a clock skew).

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// refreshLocks serializes token refreshes BY SERVER NAME, process-wide.
//
// The lock cannot live on the resolver. A resolver is built per connection, and
// the same server is connected once per conversation, so a per-resolver mutex
// only serializes calls within one conversation — two conversations hitting the
// expired token at the same moment each refresh independently. Providers rotate
// the refresh token on use (Supabase does), so the second refresh presents a
// token the first just invalidated: one conversation ends up authorized and the
// other is logged out, with no way back except a fresh `ion mcp login`.
//
// Keying by server name puts every conversation in the daemon behind one lock,
// which is the actual scope of the shared resource — the single on-disk token.
var refreshLocks sync.Map // serverName -> *sync.Mutex

// refreshLockFor returns the process-wide refresh mutex for a server.
func refreshLockFor(serverName string) *sync.Mutex {
	actual, _ := refreshLocks.LoadOrStore(serverName, &sync.Mutex{})
	mu, ok := actual.(*sync.Mutex)
	if !ok {
		// Cannot happen: this map only ever stores *sync.Mutex. Falling back to a
		// fresh mutex keeps the caller correct-but-unserialized rather than
		// panicking inside a token refresh.
		utils.LogWithFields(utils.LevelError, "mcp.oauth", "refresh lock map held an unexpected type", map[string]any{
			"serverName": serverName,
		})
		return &sync.Mutex{}
	}
	return mu
}

// tokenResolver produces a bearer token for one MCP server on demand.
//
// Stateless beyond its identity: the token itself lives in the process-global
// OAuthStore, so resolvers for the same server built by different conversations
// all read and write the same credential and share one refresh lock.
type tokenResolver struct {
	serverName string
	config     *OAuthConfig
}

// newTokenResolver builds a resolver for a server, or returns nil when the
// server has no OAuth credentials at all (no configured block and no stored
// registration). A nil resolver means "send no Authorization header", which is
// correct for a server that needs none.
func newTokenResolver(serverName string, oauthConfig *OAuthConfig) *tokenResolver {
	effective := effectiveOAuthConfig(serverName, oauthConfig)
	if effective == nil {
		return nil
	}
	return &tokenResolver{serverName: serverName, config: effective}
}

// Token returns the token to send on the next request, refreshing first when
// the stored one is expired or within the expiry safety window.
//
// A refresh failure is returned rather than swallowed: the caller sends no
// Authorization header and the server's 401 then carries the connect-path
// remediation, which is more actionable than a request that silently omits auth.
func (r *tokenResolver) Token() (string, error) {
	store := getOAuthStore()

	// GetToken already returns nil for an expired token (60s safety buffer), so
	// this covers both "valid" and "needs refresh" without a second check.
	if tok := store.GetToken(r.serverName); tok != nil {
		return bearerValue(tok), nil
	}

	// A grant the provider has permanently rejected cannot be revived by trying
	// again, so re-presenting it costs a network round trip per request and
	// returns the same answer. classifyGrantFailure already decided this is
	// terminal; honouring that decision here is what keeps the cost bounded.
	if dead := lastGrantFailure(r.serverName); dead != nil {
		return "", fmt.Errorf("refresh token for %s: %w", r.serverName, dead)
	}

	unlock := r.lockRefresh()
	defer unlock()

	// Re-check under the lock: a concurrent caller — including one in a different
	// conversation — may have just refreshed. This is what turns N concurrent
	// expiries into ONE refresh plus N-1 cache hits.
	if tok := store.GetToken(r.serverName); tok != nil {
		return bearerValue(tok), nil
	}

	// Re-check the death marker under the lock too: the caller that held the
	// lock before this one may have just proven the grant dead, and without
	// this every waiter on that lock still issues its own doomed refresh.
	if dead := lastGrantFailure(r.serverName); dead != nil {
		return "", fmt.Errorf("refresh token for %s: %w", r.serverName, dead)
	}

	utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "access token expired; refreshing before request", map[string]any{
		"serverName": r.serverName,
	})
	tok, err := store.RefreshToken(r.serverName, r.config)
	if err != nil {
		return "", fmt.Errorf("refresh token for %s: %w", r.serverName, err)
	}
	utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "access token refreshed", map[string]any{
		"serverName": r.serverName, "expiresAt": tok.ExpiresAt.Format(time.RFC3339),
	})
	return bearerValue(tok), nil
}

// ForceRefresh refreshes a token the provider rejected, ignoring the stored
// expiry.
//
// This exists for the 401-retry path: the provider has rejected a token the
// engine still considers valid, so trusting the local expiry would retry with
// the same dead credential.
//
// rejected is the Authorization value that was refused. It makes the
// double-refresh check possible: if the stored token no longer matches it,
// another caller has already replaced it and this one adopts that result instead
// of refreshing again — which would invalidate the token the other conversation
// just obtained.
func (r *tokenResolver) ForceRefresh(rejected string) (string, error) {
	unlock := r.lockRefresh()
	defer unlock()

	// Re-check under the lock. Two conversations can be rejected by the provider
	// at the same instant; the second must adopt the first's fresh token rather
	// than refresh again and invalidate it.
	if tok := getOAuthStore().GetToken(r.serverName); tok != nil && bearerValue(tok) != rejected {
		utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "another caller already refreshed after the rejection; reusing", map[string]any{
			"serverName": r.serverName,
		})
		return bearerValue(tok), nil
	}

	// The 401 that drove this retry is expected when the grant is already known
	// dead: no token was sent, so the server refused an unauthenticated request.
	// Refreshing cannot change that, and doing it here is what turned one dead
	// credential into three failed token-endpoint calls per connect.
	if dead := lastGrantFailure(r.serverName); dead != nil {
		return "", fmt.Errorf("force refresh token for %s: %w", r.serverName, dead)
	}

	utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "server rejected the token; forcing a refresh", map[string]any{
		"serverName": r.serverName,
	})
	tok, err := getOAuthStore().RefreshToken(r.serverName, r.config)
	if err != nil {
		return "", fmt.Errorf("force refresh token for %s: %w", r.serverName, err)
	}
	utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "token refreshed after rejection", map[string]any{
		"serverName": r.serverName, "expiresAt": tok.ExpiresAt.Format(time.RFC3339),
	})
	return bearerValue(tok), nil
}

// lockRefresh takes this server's process-wide refresh lock and returns its
// release func.
func (r *tokenResolver) lockRefresh() func() {
	mu := refreshLockFor(r.serverName)
	mu.Lock()
	return mu.Unlock
}

// HasCredentials reports whether a token or refresh token is stored, so a
// transport can skip a pointless retry for a server that was never authorized.
func (r *tokenResolver) HasCredentials() bool {
	if r == nil {
		return false
	}
	store := getOAuthStore()
	if store.GetToken(r.serverName) != nil {
		return true
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	tok, ok := store.tokens[r.serverName]
	return ok && tok != nil && tok.RefreshToken != ""
}

// effectiveOAuthConfig resolves the OAuth config for a server: the operator's
// explicit engine.json block when present, otherwise the endpoints a completed
// `ion mcp login` stored. Returns nil when neither exists.
//
// Extracted from resolveOAuthHeaders so the per-request resolver and the
// connect-time header path share one precedence rule.
func effectiveOAuthConfig(serverName string, oauthConfig *OAuthConfig) *OAuthConfig {
	if oauthConfig != nil {
		return oauthConfig
	}
	reg := getClientStore().Get(serverName)
	if reg == nil {
		utils.LogWithFields(utils.LevelDebug, "mcp.oauth", "no oauth config and no stored client registration", map[string]any{
			"serverName": serverName,
		})
		return nil
	}
	return &OAuthConfig{
		ClientID:     reg.ClientID,
		ClientSecret: reg.ClientSecret,
		AuthURL:      reg.AuthURL,
		TokenURL:     reg.TokenURL,
		Scope:        reg.Scope,
		RedirectURI:  reg.RedirectURI,
		UsePKCE:      true,
		Resource:     reg.Resource,
	}
}

// bearerValue renders a stored token as an Authorization header value,
// normalizing the token type ("bearer" -> "Bearer").
func bearerValue(tok *OAuthToken) string {
	tokenType := tok.TokenType
	if tokenType == "" {
		tokenType = "Bearer"
	}
	if len(tokenType) > 0 {
		tokenType = strings.ToUpper(tokenType[:1]) + tokenType[1:]
	}
	return tokenType + " " + tok.AccessToken
}
