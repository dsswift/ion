package mcp

// login.go — interactive OAuth login for a remote MCP server.
//
// This is the producer the token store never had. Before this file,
// OAuthStore.SetToken was reachable only from RefreshToken, so a token could
// be refreshed but never obtained: resolveOAuthHeaders would find nothing on
// disk, connect unauthenticated, and every tool on the server would 401.
//
// The flow, in order:
//
//  1. Resolve the client — an explicit engine.json `oauth` block wins; else a
//     stored dynamic registration; else discover + register.
//  2. Run authorization-code + PKCE via auth.StartPKCEFlow. The engine owns
//     the loopback callback server and the code exchange; the consumer only
//     opens the returned URL.
//  3. Persist the resulting grant to OAuthStore so connect (and refresh) find
//     it.
//
// Step 2 is entirely auth's: no verifier, challenge, callback listener, or
// exchange is reimplemented here. A second PKCE implementation would drift
// from the one the operator-identity flow uses.

import (
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// loginRedirectPath is the loopback callback path for MCP authorization. It is
// distinct from the operator-identity flow's "/callback" so a provider's
// registered-redirect list makes the two purposes distinguishable.
const loginRedirectPath = "/mcp/callback"

// loginRedirectHost is the loopback host for the callback. 127.0.0.1 is the
// literal form RFC 8252 recommends for native apps.
const loginRedirectHost = "127.0.0.1"

// LoginResult describes a started MCP login. AuthorizationURL is what a
// consumer opens in a browser; Done fires once the engine's callback server
// has completed the exchange and the token is persisted; Err carries any
// failure. Cancel aborts the flow. Mirrors auth.LoginResult so a consumer that
// already drives operator login needs no new shape.
type LoginResult struct {
	AuthorizationURL string
	Done             <-chan struct{}
	Err              <-chan error
	Cancel           func()
}

// reserveLoopbackPort picks a free loopback port and releases it.
//
// Why a pre-reserved port rather than letting StartPKCEFlow auto-assign:
// RFC 7591 registration binds the redirect_uri, so the port must be known
// BEFORE registration and reused on every later authorization request for the
// same client. RFC 8252 § 7.3 tells authorization servers to ignore the port
// on loopback redirects for exactly this reason, but not every server obeys —
// pinning the port keeps a byte-identical URI across registration and login.
//
// The reserve-then-release window is a benign race: if another process claims
// the port in between, StartPKCEFlow's Listen fails with a clear bind error
// and the operator retries. The alternative (an unbound port) fails later and
// less legibly, at the provider's redirect check.
func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", loginRedirectHost+":0")
	if err != nil {
		return 0, fmt.Errorf("reserve loopback port: %w", err)
	}
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		if closeErr := listener.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.login", "port reservation close failed", map[string]any{"error": closeErr.Error()})
		}
		return 0, fmt.Errorf("reserve loopback port: listener address is not TCP: %T", listener.Addr())
	}
	port := addr.Port
	if closeErr := listener.Close(); closeErr != nil {
		return 0, fmt.Errorf("reserve loopback port: release %d: %w", port, closeErr)
	}
	return port, nil
}

// redirectURIFor builds the loopback redirect URI for a port.
func redirectURIFor(port int) string {
	return fmt.Sprintf("http://%s:%d%s", loginRedirectHost, port, loginRedirectPath)
}

// portFromRedirectURI extracts the port from a stored redirect URI so a repeat
// login reuses the registered port. Returns 0 when the URI is unparseable,
// which makes the caller reserve a fresh port.
func portFromRedirectURI(redirectURI string) int {
	if redirectURI == "" {
		return 0
	}
	idx := strings.LastIndex(redirectURI, ":")
	if idx < 0 {
		return 0
	}
	rest := redirectURI[idx+1:]
	if slash := strings.Index(rest, "/"); slash >= 0 {
		rest = rest[:slash]
	}
	port := 0
	for _, c := range rest {
		if c < '0' || c > '9' {
			return 0
		}
		port = port*10 + int(c-'0')
	}
	if port <= 0 || port > 65535 {
		return 0
	}
	return port
}

// ResolveClient returns the OAuth client to use for a server, in precedence
// order:
//
//  1. An explicit `oauth` block in engine.json — the operator's configuration
//     always wins, and is the only path for a provider that supports no
//     dynamic registration.
//  2. A stored dynamic registration from a previous login.
//  3. Fresh discovery + dynamic registration.
//
// scopeOverride, when non-empty, replaces the scope from config/discovery.
// redirectURI is the URI the caller will pin the PKCE flow to; it is only used
// when a registration has to be created.
func ResolveClient(serverName string, cfg types.McpServerConfig, scopeOverride, redirectURI string) (*ClientRegistration, error) {
	// 1. Explicit operator configuration.
	if cfg.OAuth != nil && cfg.OAuth.ClientID != "" {
		scope := cfg.OAuth.Scope
		if scopeOverride != "" {
			scope = scopeOverride
		}
		reg := &ClientRegistration{
			ClientID:     cfg.OAuth.ClientID,
			ClientSecret: cfg.OAuth.ClientSecret,
			AuthURL:      cfg.OAuth.AuthURL,
			TokenURL:     cfg.OAuth.TokenURL,
			Scope:        scope,
			RedirectURI:  cfg.OAuth.RedirectURI,
		}
		// A configured client_id with no endpoints is still resolvable when
		// the server publishes metadata — discovery fills the gaps rather
		// than forcing the operator to hand-write three URLs.
		if reg.AuthURL == "" || reg.TokenURL == "" {
			if cfg.URL == "" {
				return nil, fmt.Errorf("mcp login %s: oauth.client_id is set but auth_url/token_url are missing and the server has no url to discover from", serverName)
			}
			meta, discoveredScope, err := DiscoverForServer(serverName, cfg.URL)
			if err != nil {
				return nil, fmt.Errorf("mcp login %s: oauth.client_id is set but auth_url/token_url are missing and discovery failed: %w", serverName, err)
			}
			if reg.AuthURL == "" {
				reg.AuthURL = meta.AuthorizationEndpoint
			}
			if reg.TokenURL == "" {
				reg.TokenURL = meta.TokenEndpoint
			}
			if reg.Scope == "" {
				reg.Scope = discoveredScope
			}
			reg.Issuer = meta.Issuer
		}
		utils.LogWithFields(utils.LevelInfo, "mcp.login", "using operator-configured oauth client", map[string]any{
			"serverName": serverName, "clientId": reg.ClientID,
			"authUrl": reg.AuthURL, "tokenUrl": reg.TokenURL, "scope": reg.Scope,
		})
		return reg, nil
	}

	// 2. Stored dynamic registration.
	if stored := getClientStore().Get(serverName); stored != nil {
		if scopeOverride != "" && scopeOverride != stored.Scope {
			// A changed scope needs the provider's consent for the new set;
			// the stored client is still the right client, so carry it with
			// the new scope rather than re-registering.
			utils.LogWithFields(utils.LevelInfo, "mcp.login", "stored registration reused with overridden scope", map[string]any{
				"serverName": serverName, "storedScope": stored.Scope, "requestedScope": scopeOverride,
			})
			withScope := *stored
			withScope.Scope = scopeOverride
			return &withScope, nil
		}
		utils.LogWithFields(utils.LevelInfo, "mcp.login", "using stored dynamic client registration", map[string]any{
			"serverName": serverName, "clientId": stored.ClientID, "issuer": stored.Issuer,
		})
		return stored, nil
	}

	// 3. Discover + register.
	if cfg.URL == "" {
		return nil, fmt.Errorf("mcp login %s: server has no url; OAuth login applies to http/sse/ws transports", serverName)
	}
	meta, discoveredScope, err := DiscoverForServer(serverName, cfg.URL)
	if err != nil {
		return nil, err
	}
	if !meta.SupportsS256() {
		return nil, fmt.Errorf("mcp login %s: authorization server %s does not support the S256 PKCE method", serverName, meta.Issuer)
	}
	scope := discoveredScope
	if scopeOverride != "" {
		scope = scopeOverride
	}
	return RegisterClient(serverName, meta, redirectURI, scope)
}

// BeginLogin starts an interactive OAuth login for an MCP server. It returns
// immediately with the authorization URL; the exchange completes on the
// callback server auth.StartPKCEFlow owns, and the resulting token is written
// to the shared OAuthStore before Done fires.
//
// The engine never blocks on the user here: the caller surfaces
// AuthorizationURL and watches Done/Err.
func BeginLogin(serverName string, cfg types.McpServerConfig, scopeOverride string) (*LoginResult, error) {
	// Reuse the registered redirect port when one is stored, so a repeat login
	// presents the byte-identical redirect_uri the client was registered with.
	port := 0
	if stored := getClientStore().Get(serverName); stored != nil {
		port = portFromRedirectURI(stored.RedirectURI)
	}
	if port == 0 {
		reserved, err := reserveLoopbackPort()
		if err != nil {
			return nil, fmt.Errorf("mcp login %s: %w", serverName, err)
		}
		port = reserved
	}
	redirectURI := redirectURIFor(port)

	reg, err := ResolveClient(serverName, cfg, scopeOverride, redirectURI)
	if err != nil {
		return nil, err
	}
	if reg.AuthURL == "" || reg.TokenURL == "" {
		return nil, fmt.Errorf("mcp login %s: resolved client has no authorization/token endpoint", serverName)
	}

	// An operator-configured client may carry its own registered redirect
	// URI; honoring it is required because the provider validates against
	// what IT has on file, not what the engine would prefer.
	flowPort := port
	flowPath := loginRedirectPath
	if reg.RedirectURI != "" && reg.RedirectURI != redirectURI {
		if configured := portFromRedirectURI(reg.RedirectURI); configured > 0 {
			flowPort = configured
		}
		if idx := strings.Index(reg.RedirectURI, loginRedirectHost); idx >= 0 {
			if slash := strings.Index(reg.RedirectURI[idx:], "/"); slash >= 0 {
				flowPath = reg.RedirectURI[idx+slash:]
			}
		}
		utils.LogWithFields(utils.LevelInfo, "mcp.login", "using client's registered redirect uri", map[string]any{
			"serverName": serverName, "redirectUri": reg.RedirectURI,
		})
	}

	flow, err := auth.StartPKCEFlow(auth.PKCEFlowConfig{
		ClientID:     reg.ClientID,
		ClientSecret: reg.ClientSecret,
		AuthURL:      reg.AuthURL,
		TokenURL:     reg.TokenURL,
		Scope:        reg.Scope,
		RedirectHost: loginRedirectHost,
		RedirectPort: flowPort,
		RedirectPath: flowPath,
	})
	if err != nil {
		return nil, fmt.Errorf("mcp login %s: start pkce flow: %w", serverName, err)
	}

	utils.LogWithFields(utils.LevelInfo, "mcp.login", "interactive login started", map[string]any{
		"serverName": serverName, "clientId": reg.ClientID,
		"authUrl": reg.AuthURL, "scope": reg.Scope, "redirectPort": flowPort,
	})

	doneCh := make(chan struct{}, 1)
	errCh := make(chan error, 1)

	go func() {
		select {
		case tok := <-flow.Token:
			store := getOAuthStore()
			store.SetToken(serverName, tokenFromGrant(tok))
			// Persist the endpoints the grant was minted against so a later
			// refresh needs neither discovery nor engine.json.
			persistRegistrationFromLogin(serverName, reg)
			utils.LogWithFields(utils.LevelInfo, "mcp.login", "login completed; token persisted", map[string]any{
				"serverName": serverName, "hasRefreshToken": tok.RefreshToken != "",
				"expiresAt": tok.ExpiresAt.Format(time.RFC3339), "scope": tok.Scope,
			})
			doneCh <- struct{}{}
		case flowErr := <-flow.Err:
			utils.LogWithFields(utils.LevelError, "mcp.login", "login did not complete", map[string]any{
				"serverName": serverName, "error": flowErr.Error(),
			})
			errCh <- flowErr
		}
	}()

	return &LoginResult{
		AuthorizationURL: flow.AuthorizationURL,
		Done:             doneCh,
		Err:              errCh,
		Cancel:           flow.Cancel,
	}, nil
}

// tokenFromGrant converts an auth.TokenResponse into the store's OAuthToken.
// A grant with no expires_in gets a conservative one-hour expiry rather than
// the zero time, which IsExpired would read as "already expired" and would
// make every request attempt a refresh.
func tokenFromGrant(tok *auth.TokenResponse) *OAuthToken {
	expiresAt := tok.ExpiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(time.Hour)
	}
	tokenType := tok.TokenType
	if tokenType == "" {
		tokenType = "Bearer"
	}
	return &OAuthToken{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		TokenType:    tokenType,
		ExpiresAt:    expiresAt,
		Scope:        tok.Scope,
	}
}

// persistRegistrationFromLogin stores the client a successful login used, so
// the refresh path can find its token_url without re-running discovery. A
// dynamically-registered client is already stored by RegisterClient; this
// covers the operator-configured path, where nothing else would persist the
// endpoints.
func persistRegistrationFromLogin(serverName string, reg *ClientRegistration) {
	store := getClientStore()
	if existing := store.Get(serverName); existing != nil &&
		existing.ClientID == reg.ClientID && existing.TokenURL == reg.TokenURL {
		return
	}
	stored := *reg
	if stored.RegisteredAt.IsZero() {
		stored.RegisteredAt = time.Now()
	}
	store.Set(serverName, &stored)
}

// Logout drops a server's stored token and client registration.
//
// The registration goes too, not just the token: leaving it behind would keep
// a client_id the operator believes they revoked, and the next login would
// silently reuse it instead of registering fresh. Logout means "forget this
// server's credentials", and a dynamically-registered client_id is one.
func Logout(serverName string) {
	getOAuthStore().DeleteToken(serverName)
	getClientStore().Delete(serverName)
	utils.LogWithFields(utils.LevelInfo, "mcp.login", "logged out; token and client registration removed", map[string]any{
		"serverName": serverName,
	})
}

// IsAuthenticated reports whether a usable (unexpired) token is stored for a
// server. Consumers render this; the engine holds no opinion about how.
func IsAuthenticated(serverName string) bool {
	return getOAuthStore().GetToken(serverName) != nil
}

// annotateAuthFailure enriches a connect-path error that is really an
// authorization rejection with the discovered issuer and the exact remediation.
//
// Why this matters: a 401 from initialize surfaces at session start as "mcp
// initialize <name>: HTTP error (status 401)", which tells an operator nothing
// about what to do. The engine is headless, so that log line is the only
// window into a server whose entire tool set just vanished. Naming the
// authorization server and the command that fixes it makes the failure
// self-explaining in engine.jsonl.
//
// Non-auth errors pass through untouched, and discovery failures never mask
// the original error — the returned error always still wraps err.
func annotateAuthFailure(serverName string, config types.McpServerConfig, err error) error {
	if err == nil || !isAuthRejection(err) {
		return err
	}

	authenticated := IsAuthenticated(serverName)
	fields := map[string]any{
		"serverName": serverName, "authenticated": authenticated, "error": err.Error(),
	}

	// Discovery is best-effort here: it enriches the message when it works and
	// is silently irrelevant when it does not (a 401 from a server publishing
	// no metadata still needs the remediation line).
	var issuer string
	if config.URL != "" {
		if meta, _, discErr := DiscoverForServer(serverName, config.URL); discErr == nil {
			issuer = meta.Issuer
			fields["issuer"] = issuer
			fields["supportsDcr"] = meta.RegistrationEndpoint != ""
		} else {
			fields["discoveryError"] = discErr.Error()
		}
	}

	utils.LogWithFields(utils.LevelError, "mcp", "server rejected the connection as unauthorized", fields)

	switch {
	case authenticated:
		// A stored token was sent and still rejected: re-login is the fix, not
		// a first login. Saying "run login" without this distinction would
		// send the operator to a command they already ran.
		return fmt.Errorf("%w — the stored token for %q was rejected; run `ion mcp logout %s` then `ion mcp login %s` to re-authorize",
			err, serverName, serverName, serverName)
	case issuer != "":
		return fmt.Errorf("%w — %q requires authorization from %s; run `ion mcp login %s`",
			err, serverName, issuer, serverName)
	default:
		return fmt.Errorf("%w — %q requires authorization; run `ion mcp login %s`",
			err, serverName, serverName)
	}
}

// isAuthRejection reports whether an error from the connect path is an
// authorization rejection.
//
// Matching on the message is the available mechanism: the transports return
// formatted errors ("HTTP error (status 401): ...", the SSE non-2xx log path)
// rather than typed ones, and the JSON-RPC layer can also surface a server's
// own auth error as an rpc error string. Both 401 (unauthenticated) and 403
// (insufficient scope) route here — a scope problem is also fixed by
// re-authorizing.
func isAuthRejection(err error) bool {
	msg := err.Error()
	for _, marker := range []string{"status 401", "status 403", "401 Unauthorized", "403 Forbidden", "invalid_token", "Unauthorized"} {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}
