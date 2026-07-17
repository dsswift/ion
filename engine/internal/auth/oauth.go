package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// TokenResponse is the full OAuth token-endpoint response captured by the
// authorization-code (PKCE), device-code, and refresh-token grants. Unlike a
// bare access-token string, it preserves the durable parts of the grant: the
// refresh_token (which lets the engine silently mint new access tokens,
// including per-scope tokens for downstream resources) and the id_token
// (which carries the authenticated user's identity claims for attribution).
type TokenResponse struct {
	AccessToken  string
	RefreshToken string
	IDToken      string
	TokenType    string
	Scope        string
	ExpiresAt    time.Time
}

// wireTokenResponse is the raw JSON shape of an OAuth token-endpoint
// response, shared by every grant type in this package.
type wireTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

// toTokenResponse converts the wire shape to the exported TokenResponse,
// computing the absolute expiry from expires_in when present.
func (w *wireTokenResponse) toTokenResponse() *TokenResponse {
	tok := &TokenResponse{
		AccessToken:  w.AccessToken,
		RefreshToken: w.RefreshToken,
		IDToken:      w.IDToken,
		TokenType:    w.TokenType,
		Scope:        w.Scope,
	}
	if w.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(w.ExpiresIn) * time.Second)
	}
	return tok
}

// OIDCDiscovery is the subset of the OpenID Provider Metadata document
// (RFC 8414 / OIDC Discovery) the engine consumes when a provider is
// configured by issuerUrl instead of explicit endpoints.
type OIDCDiscovery struct {
	Issuer                      string `json:"issuer"`
	AuthorizationEndpoint       string `json:"authorization_endpoint"`
	TokenEndpoint               string `json:"token_endpoint"`
	DeviceAuthorizationEndpoint string `json:"device_authorization_endpoint"`
}

// DiscoverOIDC fetches <issuer>/.well-known/openid-configuration and
// returns the provider metadata. issuer may carry a trailing slash.
func DiscoverOIDC(issuer string) (*OIDCDiscovery, error) {
	wellKnown := strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration"
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(wellKnown)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: fetch %s: %w", wellKnown, err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.oauth", "discovery response body close failed", map[string]any{"error": err.Error()})
		}
	}()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc discovery: %s returned status %d", wellKnown, resp.StatusCode)
	}
	var doc OIDCDiscovery
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("oidc discovery: parse metadata: %w", err)
	}
	if doc.TokenEndpoint == "" {
		return nil, fmt.Errorf("oidc discovery: metadata from %s has no token_endpoint", wellKnown)
	}
	utils.LogWithFields(utils.LevelInfo, "auth.oauth", "oidc discovery resolved", map[string]any{
		"path":   wellKnown,
		"status": doc.Issuer,
	})
	return &doc, nil
}

// audienceParamName normalizes the configured audience-parameter dialect:
// "audience" (default, the prevailing de-facto name) or "resource"
// (RFC 8707 Resource Indicators).
func audienceParamName(configured string) string {
	if configured == "resource" {
		return "resource"
	}
	return "audience"
}

// DeviceFlowResult contains the parameters from a device authorization request.
type DeviceFlowResult struct {
	DeviceCode string `json:"device_code"`
	UserCode   string `json:"user_code"`
	VerifyURI  string `json:"verification_uri"`
	ExpiresIn  int    `json:"expires_in"`
	Interval   int    `json:"interval"`
}

// InitiateDeviceFlow starts the OAuth 2.0 device authorization flow.
// The caller should display the UserCode and VerifyURI to the user.
// scope is the space-separated scope string for the grant; when empty it
// defaults to "openid". Identity flows that need a refresh token must
// include "offline_access" (and any downstream resource scopes) here.
// audience, when non-empty, is sent under the configured parameter
// dialect (see audienceParamName) for IdPs that bind grants to an
// explicit audience/resource rather than encoding it in the scope.
func InitiateDeviceFlow(clientID, tokenURL, scope, audience, audienceParam string) (*DeviceFlowResult, error) {
	// Device flow uses the authorization endpoint, typically at
	// tokenURL minus "/token" plus "/device/code" or similar.
	// We accept the full device authorization URL as tokenURL here.
	if scope == "" {
		scope = "openid"
	}
	form := url.Values{
		"client_id": {clientID},
		"scope":     {scope},
	}
	if audience != "" {
		form.Set(audienceParamName(audienceParam), audience)
	}

	resp, err := http.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("device flow request failed: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.oauth", "initiate device flow response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("device flow failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result DeviceFlowResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("device flow response parse error: %w", err)
	}

	if result.Interval == 0 {
		result.Interval = 5 // Default polling interval
	}

	return &result, nil
}

// ExchangeDeviceCode polls the token endpoint to exchange a device code
// for a token. This is a single poll attempt; the caller should loop with
// the interval from DeviceFlowResult. The returned TokenResponse carries
// the full grant (refresh_token, id_token) so the caller can persist the
// durable identity, not just the short-lived access token.
func ExchangeDeviceCode(clientID, deviceCode, tokenURL string) (*TokenResponse, error) {
	form := url.Values{
		"client_id":   {clientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("token exchange request failed: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.oauth", "exchange device code response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("token exchange read error: %w", err)
	}

	var tokenResp wireTokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("token exchange parse error: %w", err)
	}

	if tokenResp.Error != "" {
		return nil, fmt.Errorf("token exchange error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("no access token in response")
	}

	return tokenResp.toTokenResponse(), nil
}

// --- PKCE Authorization Code Flow ---

// PKCEFlowConfig holds OAuth PKCE configuration.
type PKCEFlowConfig struct {
	ClientID     string
	AuthURL      string // authorization endpoint
	TokenURL     string // token exchange endpoint
	Scope        string
	RedirectPort int // 0 = auto-assign
	// RedirectHost is the loopback host used in the redirect URI and for the
	// local callback listener. Defaults to "127.0.0.1". Some identity
	// providers apply special loopback matching rules keyed on the literal
	// host string: Microsoft Entra, for example, matches public-client
	// redirect URIs registered as http://localhost/callback on host+path and
	// ignores the ephemeral port -- but only for the "localhost" spelling.
	// Set "localhost" for such providers.
	RedirectHost string
	// RedirectPath is the callback path. Defaults to "/callback". It must
	// match the path portion of the redirect URI registered with the
	// identity provider.
	RedirectPath string
	// Audience, when non-empty, is sent on the authorization request under
	// AudienceParam's dialect ("audience" default, "resource" for RFC
	// 8707). Required by IdPs (e.g. Auth0) that bind the grant to an
	// explicit audience rather than encoding it in the scope string.
	Audience      string
	AudienceParam string
}

// PKCEFlowResult contains the started flow's URL and completion channel.
type PKCEFlowResult struct {
	AuthorizationURL string
	Token            <-chan *TokenResponse
	Err              <-chan error
	Cancel           func()
}

// StartPKCEFlow initiates OAuth 2.0 Authorization Code + PKCE flow.
// It starts a local HTTP server on the loopback host to receive the
// authorization callback, then returns the authorization URL for the caller
// to open in a browser. The Token channel receives the full token response
// (access + refresh + id token) on success; the Err channel receives any
// error. The entire flow times out after 5 minutes.
func StartPKCEFlow(cfg PKCEFlowConfig) (*PKCEFlowResult, error) {
	verifier, err := generateCodeVerifier()
	if err != nil {
		return nil, fmt.Errorf("pkce: generate verifier: %w", err)
	}
	challenge := generateCodeChallenge(verifier)

	state, err := generateState()
	if err != nil {
		return nil, fmt.Errorf("pkce: generate state: %w", err)
	}

	// Start local callback server on the configured loopback host. The host
	// string is preserved verbatim in the redirect URI because providers
	// like Entra match on it literally (see PKCEFlowConfig.RedirectHost).
	host := cfg.RedirectHost
	if host == "" {
		host = "127.0.0.1"
	}
	path := cfg.RedirectPath
	if path == "" {
		path = "/callback"
	}
	addr := fmt.Sprintf("%s:%d", host, cfg.RedirectPort)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("pkce: listen on %s: %w", addr, err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	redirectURI := fmt.Sprintf("http://%s:%d%s", host, port, path)

	// Build authorization URL.
	authURL, err := buildAuthorizationURL(cfg, redirectURI, challenge, state)
	if err != nil {
		if closeErr := listener.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.oauth", "pkce listener close after auth-url build failure", map[string]any{"error": closeErr.Error()})
		}
		return nil, fmt.Errorf("pkce: build auth url: %w", err)
	}

	tokenCh := make(chan *TokenResponse, 1)
	errCh := make(chan error, 1)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)

	mux := http.NewServeMux()
	server := &http.Server{Handler: mux}

	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		if errParam := q.Get("error"); errParam != "" {
			desc := q.Get("error_description")
			errCh <- fmt.Errorf("authorization error: %s: %s", errParam, desc)
			w.Header().Set("Content-Type", "text/html")
			if _, err := fmt.Fprintf(w, "<html><body><p>Authorization failed. You can close this tab.</p></body></html>"); err != nil {
				utils.LogWithFields(utils.LevelInfo, "auth.oauth", "pkce write failure page", map[string]any{"error": err.Error()})
			}
			go shutdownAndLog(server, "auth-error")
			return
		}

		if q.Get("state") != state {
			errCh <- fmt.Errorf("state mismatch")
			http.Error(w, "state mismatch", http.StatusBadRequest)
			go shutdownAndLog(server, "state-mismatch")
			return
		}

		code := q.Get("code")
		if code == "" {
			errCh <- fmt.Errorf("no authorization code in callback")
			http.Error(w, "missing code", http.StatusBadRequest)
			go shutdownAndLog(server, "missing-code")
			return
		}

		token, exchangeErr := exchangeCodeForToken(cfg, code, verifier, redirectURI)
		if exchangeErr != nil {
			errCh <- exchangeErr
			w.Header().Set("Content-Type", "text/html")
			if _, err := fmt.Fprintf(w, "<html><body><p>Token exchange failed. You can close this tab.</p></body></html>"); err != nil {
				utils.LogWithFields(utils.LevelInfo, "auth.oauth", "pkce write exchange-failure page", map[string]any{"error": err.Error()})
			}
			go shutdownAndLog(server, "exchange-error")
			return
		}

		tokenCh <- token
		w.Header().Set("Content-Type", "text/html")
		if _, err := fmt.Fprintf(w, "<html><body><p>Authorization complete. You can close this tab.</p></body></html>"); err != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.oauth", "pkce write success page", map[string]any{"error": err.Error()})
		}
		go shutdownAndLog(server, "success")
	})

	// Run server in background; shut down on context cancellation.
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
			errCh <- fmt.Errorf("pkce: callback server: %w", serveErr)
		}
	}()

	go func() {
		<-ctx.Done()
		if ctx.Err() == context.DeadlineExceeded {
			errCh <- fmt.Errorf("pkce: flow timed out after 5 minutes")
		}
		shutdownAndLog(server, "ctx-done")
	}()

	return &PKCEFlowResult{
		AuthorizationURL: authURL,
		Token:            tokenCh,
		Err:              errCh,
		Cancel: func() {
			cancel()
			shutdownAndLog(server, "cancel")
		},
	}, nil
}

// shutdownAndLog wraps server.Shutdown so the error is observable in
// logs rather than silently discarded. Used from every place the OAuth
// callback server needs to wind down — error branches, success, the
// context-cancel watcher, and the public Cancel hook. The shutdown
// path is best-effort: if it fails, the process is exiting anyway, so
// we log rather than escalate.
func shutdownAndLog(server *http.Server, reason string) {
	if err := server.Shutdown(context.Background()); err != nil {
		utils.LogWithFields(utils.LevelInfo, "auth.oauth", "pkce server shutdown failed", map[string]any{"reason": reason, "error": err.Error()})
	}
}

// generateCodeVerifier creates a 32-byte random verifier encoded as base64url.
func generateCodeVerifier() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// generateCodeChallenge computes the S256 challenge from a verifier.
func generateCodeChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// generateState creates a random state parameter.
func generateState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// buildAuthorizationURL constructs the full authorization endpoint URL.
func buildAuthorizationURL(cfg PKCEFlowConfig, redirectURI, challenge, state string) (string, error) {
	u, err := url.Parse(cfg.AuthURL)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("client_id", cfg.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	if cfg.Scope != "" {
		q.Set("scope", cfg.Scope)
	}
	if cfg.Audience != "" {
		q.Set(audienceParamName(cfg.AudienceParam), cfg.Audience)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// exchangeCodeForToken exchanges an authorization code for a token. The
// full token response is returned (not just the access token) so the caller
// can persist the refresh_token and id_token -- the durable halves of the
// grant that make the engine the authoritative owner of the user's identity.
func exchangeCodeForToken(cfg PKCEFlowConfig, code, verifier, redirectURI string) (*TokenResponse, error) {
	form := url.Values{
		"client_id":     {cfg.ClientID},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirectURI},
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(cfg.TokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("pkce token exchange request failed: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.oauth", "exchange code for token response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("pkce token exchange read error: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("pkce token exchange failed (status %d): %s", resp.StatusCode, string(body))
	}

	var tokenResp wireTokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("pkce token exchange parse error: %w", err)
	}

	if tokenResp.Error != "" {
		return nil, fmt.Errorf("pkce token exchange error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("pkce: no access token in response")
	}

	return tokenResp.toTokenResponse(), nil
}
