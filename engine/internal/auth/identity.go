// Package auth: engine-owned OIDC operator identity.
//
// IdentityManager makes the engine the authoritative owner of the signed-in
// operator's OIDC identity: it drives the interactive PKCE login (a UI
// consumer only opens the authorization URL; the engine's loopback callback
// server completes the exchange), persists the durable grant (refresh token
// + id token) in the encrypted filestore, and silently mints per-scope
// access tokens for downstream resources from the single refresh token.
//
// Every engine consumer of the operator's identity -- the SDK's
// pre-authenticated HTTP surface, per-server MCP token forwarding, and
// authenticated log egress -- resolves tokens through the TokenProvider
// seam. The raw token never crosses into extension code; consumers receive
// either an injected Authorization header or a short-lived access token
// scoped to exactly the resource they declared.
package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// TokenProvider is the internal seam through which engine subsystems obtain
// a valid access token for the signed-in operator. scope names the
// downstream permission set; on IdPs that encode the resource in the scope
// string (Entra: "api://<app-id>/Billing.Read") scope alone suffices, while
// IdPs that bind grants to an explicit audience (Auth0, RFC 8707 resource
// indicators) additionally take an audience. An empty scope returns a token
// carrying the base grant's scope. Implementations refresh or mint
// silently -- callers never handle refresh tokens.
type TokenProvider interface {
	// GetToken returns a currently-valid access token for the given scope,
	// refreshing or minting one from the stored grant when needed. The
	// provider's configured default audience (if any) applies.
	GetToken(ctx context.Context, scope string) (string, error)
	// GetTokenWithAudience is GetToken with an explicit per-request
	// audience/resource. Empty audience falls back to the provider's
	// configured default.
	GetTokenWithAudience(ctx context.Context, scope, audience string) (string, error)
	// Identity returns the signed-in operator's identity claims, or nil
	// when no operator is signed in.
	Identity() *OperatorIdentity
}

// OperatorIdentity carries the identity claims of the signed-in operator,
// extracted from the OIDC id_token.
type OperatorIdentity struct {
	// Subject is the stable subject identifier (Entra: the oid claim,
	// falling back to sub).
	Subject string `json:"subject"`
	// Username is the human-readable identity used for attribution
	// (Entra: preferred_username -- UPN/email for work accounts).
	Username string `json:"username"`
	// Name is the display name claim when present.
	Name string `json:"name,omitempty"`
	// Provider is the auth-config key this identity was minted under
	// (e.g. "entra").
	Provider string `json:"provider"`
	// Attribution is the value of the configured attributionClaim, when
	// set. Takes precedence over the standard fallback chain in
	// AttributionValue.
	Attribution string `json:"attribution,omitempty"`
}

// AttributionValue returns the identity string stamped on telemetry and
// egress records: the configured attributionClaim's value when set, else
// preferred_username, else the subject.
func (id *OperatorIdentity) AttributionValue() string {
	if id == nil {
		return ""
	}
	if id.Attribution != "" {
		return id.Attribution
	}
	if id.Username != "" {
		return id.Username
	}
	return id.Subject
}

// defaultRefreshThreshold is how long before expiry a cached access token
// is considered stale and proactively refreshed. Overridable via
// AuthConfig.RefreshThresholdMs.
const defaultRefreshThreshold = 60 * time.Second

// IdentityManager owns the operator's OIDC identity lifecycle for one
// configured provider. It is safe for concurrent use.
type IdentityManager struct {
	provider string
	cfg      types.OAuthConfig
	fs       *FileStore

	refreshThreshold time.Duration

	mu sync.Mutex
	// scopeCache holds minted access tokens keyed by scope+audience.
	// Access tokens are short-lived by design, so they live in memory
	// only; the durable refresh token is what persists (encrypted, on
	// disk).
	scopeCache map[string]oauthToken
	// identity is the parsed id_token claims, cached after first parse.
	identity *OperatorIdentity
	// endpointsResolved marks a completed OIDC discovery pass (issuerUrl
	// config). Guarded by mu; a failed pass retries on the next call.
	endpointsResolved bool
}

// cacheKey builds the scopeCache key for a scope+audience pair. The
// separator cannot appear in either value (NUL is invalid in both).
func cacheKey(scope, audience string) string {
	return scope + "\x00" + audience
}

// resolveEndpoints fills empty endpoint URLs from OIDC discovery when the
// provider is configured by issuerUrl. Explicit URLs always win; a
// provider configured entirely by explicit URLs never touches the network
// here. Failed discovery returns the error and retries on the next call.
func (m *IdentityManager) resolveEndpoints() error {
	m.mu.Lock()
	done := m.endpointsResolved
	issuer := m.cfg.IssuerURL
	m.mu.Unlock()
	if done || issuer == "" {
		return nil
	}

	doc, err := DiscoverOIDC(issuer)
	if err != nil {
		return err
	}

	m.mu.Lock()
	if m.cfg.AuthorizationURL == "" {
		m.cfg.AuthorizationURL = doc.AuthorizationEndpoint
	}
	if m.cfg.TokenURL == "" {
		m.cfg.TokenURL = doc.TokenEndpoint
	}
	if m.cfg.DeviceAuthorizationURL == "" {
		m.cfg.DeviceAuthorizationURL = doc.DeviceAuthorizationEndpoint
	}
	m.endpointsResolved = true
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "auth.identity", "endpoints resolved via oidc discovery", map[string]any{
		"provider": m.provider,
		"path":     issuer,
	})
	return nil
}

// NewIdentityManager creates an identity manager for the given provider key
// and OAuth configuration. refreshThresholdMs <= 0 selects the default.
func NewIdentityManager(provider string, cfg types.OAuthConfig, refreshThresholdMs int64) *IdentityManager {
	threshold := defaultRefreshThreshold
	if refreshThresholdMs > 0 {
		threshold = time.Duration(refreshThresholdMs) * time.Millisecond
	}
	return &IdentityManager{
		provider:         provider,
		cfg:              cfg,
		fs:               NewFileStore(),
		refreshThreshold: threshold,
		scopeCache:       make(map[string]oauthToken),
	}
}

// storeKey returns the filestore key for the base identity grant.
func (m *IdentityManager) storeKey() string {
	return "oauth:" + m.provider
}

// Provider returns the auth-config key this manager was created for.
func (m *IdentityManager) Provider() string {
	return m.provider
}

// --- Interactive login (PKCE) ---

// LoginResult describes a started interactive login. AuthorizationURL is
// what a UI consumer opens in a browser; Done receives the signed-in
// identity when the engine's callback server completes the exchange; Err
// receives any failure. Cancel aborts the flow.
type LoginResult struct {
	AuthorizationURL string
	Done             <-chan *OperatorIdentity
	Err              <-chan error
	Cancel           func()
}

// BeginLogin starts the interactive PKCE login. The engine runs the
// loopback callback server and exchanges the code itself; the caller's only
// job is to surface AuthorizationURL to the user. On success the full grant
// is persisted and the parsed identity is delivered on Done.
func (m *IdentityManager) BeginLogin() (*LoginResult, error) {
	pkceCfg, err := m.pkceConfig()
	if err != nil {
		return nil, err
	}

	flow, err := StartPKCEFlow(pkceCfg)
	if err != nil {
		return nil, fmt.Errorf("identity: start pkce flow: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, "auth.identity", "interactive login started", map[string]any{
		"provider": m.provider,
		"scope":    pkceCfg.Scope,
	})

	doneCh := make(chan *OperatorIdentity, 1)
	errCh := make(chan error, 1)

	go func() {
		select {
		case tok := <-flow.Token:
			if err := m.CompleteLogin(tok); err != nil {
				utils.LogWithFields(utils.LevelError, "auth.identity", "login persistence failed", map[string]any{
					"provider": m.provider,
					"error":    err.Error(),
				})
				errCh <- err
				return
			}
			doneCh <- m.Identity()
		case err := <-flow.Err:
			utils.LogWithFields(utils.LevelInfo, "auth.identity", "interactive login failed", map[string]any{
				"provider": m.provider,
				"error":    err.Error(),
			})
			errCh <- err
		}
	}()

	return &LoginResult{
		AuthorizationURL: flow.AuthorizationURL,
		Done:             doneCh,
		Err:              errCh,
		Cancel:           flow.Cancel,
	}, nil
}

// pkceConfig builds the PKCE flow configuration from the provider's OAuth
// config, honoring a configured redirect URI's host and path (Entra matches
// public-client loopback redirects on the literal host+path and ignores the
// ephemeral port only for the "localhost" spelling).
func (m *IdentityManager) pkceConfig() (PKCEFlowConfig, error) {
	if err := m.resolveEndpoints(); err != nil {
		return PKCEFlowConfig{}, err
	}
	if m.cfg.ClientID == "" || m.cfg.AuthorizationURL == "" || m.cfg.TokenURL == "" {
		return PKCEFlowConfig{}, fmt.Errorf("identity: oauth config for provider %q is missing clientId, authorizationUrl, or tokenUrl (set them explicitly or configure issuerUrl for discovery)", m.provider)
	}

	pkceCfg := PKCEFlowConfig{
		ClientID:      m.cfg.ClientID,
		AuthURL:       m.cfg.AuthorizationURL,
		TokenURL:      m.cfg.TokenURL,
		Scope:         strings.Join(m.cfg.Scopes, " "),
		Audience:      m.cfg.Audience,
		AudienceParam: m.cfg.AudienceParameter,
	}

	if m.cfg.RedirectURI != "" {
		u, err := url.Parse(m.cfg.RedirectURI)
		if err != nil {
			return PKCEFlowConfig{}, fmt.Errorf("identity: parse configured redirectUri %q: %w", m.cfg.RedirectURI, err)
		}
		pkceCfg.RedirectHost = u.Hostname()
		if u.Path != "" {
			pkceCfg.RedirectPath = u.Path
		}
		if p := u.Port(); p != "" {
			var port int
			if _, err := fmt.Sscanf(p, "%d", &port); err == nil {
				pkceCfg.RedirectPort = port
			}
		}
	}

	return pkceCfg, nil
}

// --- Headless login (device code) ---

// DeviceLogin describes a started device-code login. Show UserCode and
// VerifyURI to the user, then call Wait to poll until completion.
type DeviceLogin struct {
	UserCode  string
	VerifyURI string
	ExpiresIn int

	manager    *IdentityManager
	deviceCode string
	interval   time.Duration
}

// BeginDeviceLogin starts the OAuth device-code flow for headless
// environments (no browser on the engine host). Requires
// deviceAuthorizationUrl in the provider's OAuth config.
func (m *IdentityManager) BeginDeviceLogin() (*DeviceLogin, error) {
	if err := m.resolveEndpoints(); err != nil {
		return nil, err
	}
	if m.cfg.DeviceAuthorizationURL == "" {
		return nil, fmt.Errorf("identity: provider %q has no deviceAuthorizationUrl configured (or discoverable via issuerUrl)", m.provider)
	}

	scope := strings.Join(m.cfg.Scopes, " ")
	result, err := InitiateDeviceFlow(m.cfg.ClientID, m.cfg.DeviceAuthorizationURL, scope, m.cfg.Audience, m.cfg.AudienceParameter)
	if err != nil {
		return nil, fmt.Errorf("identity: initiate device flow: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, "auth.identity", "device login started", map[string]any{
		"provider":   m.provider,
		"verify_uri": result.VerifyURI,
		"expires_in": result.ExpiresIn,
	})

	return &DeviceLogin{
		UserCode:   result.UserCode,
		VerifyURI:  result.VerifyURI,
		ExpiresIn:  result.ExpiresIn,
		manager:    m,
		deviceCode: result.DeviceCode,
		interval:   time.Duration(result.Interval) * time.Second,
	}, nil
}

// Wait polls the token endpoint until the user completes authorization, the
// context is cancelled, or the device code expires. On success the grant is
// persisted and the identity returned.
func (d *DeviceLogin) Wait(ctx context.Context) (*OperatorIdentity, error) {
	deadline := time.Now().Add(time.Duration(d.ExpiresIn) * time.Second)
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			if time.Now().After(deadline) {
				return nil, fmt.Errorf("identity: device login expired before completion")
			}
			tok, err := ExchangeDeviceCode(d.manager.cfg.ClientID, d.deviceCode, d.manager.cfg.TokenURL)
			if err != nil {
				// authorization_pending / slow_down are normal mid-poll states.
				if strings.Contains(err.Error(), "authorization_pending") {
					continue
				}
				if strings.Contains(err.Error(), "slow_down") {
					ticker.Reset(d.interval + 5*time.Second)
					continue
				}
				return nil, err
			}
			if err := d.manager.CompleteLogin(tok); err != nil {
				return nil, err
			}
			return d.manager.Identity(), nil
		}
	}
}

// --- Grant persistence and token minting ---

// CompleteLogin persists a freshly-granted token bundle as the operator's
// identity. Exposed for flows where an external surface performed the
// exchange as well as for the engine's own PKCE/device completions.
func (m *IdentityManager) CompleteLogin(tok *TokenResponse) error {
	if tok == nil || tok.AccessToken == "" {
		return fmt.Errorf("identity: empty token response")
	}
	if tok.RefreshToken == "" {
		// Without a refresh token the engine cannot silently maintain the
		// identity or mint per-scope tokens; surface it loudly. The grant
		// must request offline_access (or the provider's equivalent).
		utils.LogWithFields(utils.LevelError, "auth.identity", "login grant carries no refresh token; silent refresh unavailable", map[string]any{
			"provider": m.provider,
			"scope":    tok.Scope,
		})
	}

	stored := oauthToken{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		ExpiresAt:    tok.ExpiresAt,
		IDToken:      tok.IDToken,
		TokenType:    tok.TokenType,
		Scope:        tok.Scope,
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("identity: marshal token: %w", err)
	}
	if err := m.fs.SetKey(m.storeKey(), string(encoded)); err != nil {
		return fmt.Errorf("identity: persist token: %w", err)
	}

	m.mu.Lock()
	m.scopeCache = make(map[string]oauthToken)
	m.identity = nil
	if tok.Scope != "" {
		m.scopeCache[cacheKey(tok.Scope, m.cfg.Audience)] = stored
	}
	m.mu.Unlock()

	identity := m.Identity()
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "operator signed in", map[string]any{
		"provider":          m.provider,
		"scope":             tok.Scope,
		"has_refresh_token": tok.RefreshToken != "",
		"has_id_token":      tok.IDToken != "",
		"user":              identity.AttributionValue(),
	})
	return nil
}

// SignedIn reports whether a persisted identity grant exists.
func (m *IdentityManager) SignedIn() bool {
	_, err := m.loadStored()
	return err == nil
}

// SignOut deletes the persisted grant and clears all cached tokens.
func (m *IdentityManager) SignOut() error {
	m.mu.Lock()
	m.scopeCache = make(map[string]oauthToken)
	m.identity = nil
	m.mu.Unlock()

	if err := m.fs.DeleteKey(m.storeKey()); err != nil {
		return fmt.Errorf("identity: delete stored grant: %w", err)
	}
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "operator signed out", map[string]any{"provider": m.provider})
	return nil
}

// GetToken implements TokenProvider. Equivalent to GetTokenWithAudience
// with the provider's configured default audience.
func (m *IdentityManager) GetToken(ctx context.Context, scope string) (string, error) {
	return m.GetTokenWithAudience(ctx, scope, "")
}

// GetTokenWithAudience implements TokenProvider. It returns a valid access
// token for the requested scope (and audience, on IdPs that bind grants to
// one): from the in-memory cache when fresh, otherwise minted from the
// stored refresh token via the refresh_token grant with the scope
// parameter (RFC 6749 §6) and the audience/resource parameter
// (RFC 8707 / de-facto "audience" dialect). Empty audience falls back to
// the provider's configured default audience.
func (m *IdentityManager) GetTokenWithAudience(ctx context.Context, scope, audience string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if audience == "" {
		audience = m.cfg.Audience
	}
	key := cacheKey(scope, audience)

	m.mu.Lock()
	cached, ok := m.scopeCache[key]
	m.mu.Unlock()
	if ok && m.tokenFresh(cached) {
		return cached.AccessToken, nil
	}

	stored, err := m.loadStored()
	if err != nil {
		return "", fmt.Errorf("identity: no signed-in operator for provider %q: %w", m.provider, err)
	}

	// The base grant's own access token satisfies a request for the base
	// scope (empty scope, or an exact match) under the default audience
	// while it is still fresh.
	if (scope == "" || scope == stored.Scope) && audience == m.cfg.Audience && m.tokenFresh(*stored) {
		return stored.AccessToken, nil
	}

	if stored.RefreshToken == "" {
		return "", fmt.Errorf("identity: stored grant for provider %q has no refresh token; interactive re-login required", m.provider)
	}

	if err := m.resolveEndpoints(); err != nil {
		return "", err
	}
	newTok, err := doRefreshTokenGrant(m.cfg.ClientID, stored.RefreshToken, m.cfg.TokenURL, scope, audience, m.cfg.AudienceParameter)
	if err != nil {
		return "", fmt.Errorf("identity: mint token for scope %q (audience %q): %w", scope, audience, err)
	}

	// Persist refresh-token rotation on the base grant (some providers
	// rotate on every use; losing the rotated value strands the identity).
	if newTok.RefreshToken != "" && newTok.RefreshToken != stored.RefreshToken {
		stored.RefreshToken = newTok.RefreshToken
		if encoded, marshalErr := json.Marshal(stored); marshalErr == nil {
			if storeErr := m.fs.SetKey(m.storeKey(), string(encoded)); storeErr != nil {
				utils.LogWithFields(utils.LevelError, "auth.identity", "failed to persist rotated refresh token", map[string]any{
					"provider": m.provider,
					"error":    storeErr.Error(),
				})
			}
		}
	}

	m.mu.Lock()
	m.scopeCache[key] = *newTok
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "auth.identity", "minted access token", map[string]any{
		"provider":        m.provider,
		"requested_scope": scope,
		"audience":        audience,
		"granted_scope":   newTok.Scope,
		"expires_at":      newTok.ExpiresAt,
	})
	return newTok.AccessToken, nil
}

// Identity implements TokenProvider. It parses the stored id_token's claims
// (cached after first parse) and returns nil when signed out.
func (m *IdentityManager) Identity() *OperatorIdentity {
	m.mu.Lock()
	if m.identity != nil {
		cached := *m.identity
		m.mu.Unlock()
		return &cached
	}
	m.mu.Unlock()

	stored, err := m.loadStored()
	if err != nil || stored.IDToken == "" {
		return nil
	}

	claims, err := parseJWTClaims(stored.IDToken)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "auth.identity", "id_token claim parse failed", map[string]any{
			"provider": m.provider,
			"error":    err.Error(),
		})
		return nil
	}

	identity := &OperatorIdentity{
		Provider: m.provider,
		Username: claims["preferred_username"],
		Name:     claims["name"],
	}
	// Entra: oid is the stable directory object id; sub is pairwise
	// per-app. Prefer oid, fall back to sub.
	if oid := claims["oid"]; oid != "" {
		identity.Subject = oid
	} else {
		identity.Subject = claims["sub"]
	}
	// Configurable attribution claim (generic IdPs whose human identity
	// lives in a different claim, e.g. "email"). Takes precedence in
	// AttributionValue over the preferred_username fallback chain.
	if m.cfg.AttributionClaim != "" {
		identity.Attribution = claims[m.cfg.AttributionClaim]
	}

	m.mu.Lock()
	m.identity = identity
	m.mu.Unlock()

	cached := *identity
	return &cached
}

// tokenFresh reports whether a token is valid now and beyond the refresh
// threshold (so callers never receive a token about to expire mid-request).
func (m *IdentityManager) tokenFresh(tok oauthToken) bool {
	if tok.AccessToken == "" || tok.ExpiresAt.IsZero() {
		return false
	}
	return time.Now().Add(m.refreshThreshold).Before(tok.ExpiresAt)
}

// loadStored reads the persisted base grant from the filestore.
func (m *IdentityManager) loadStored() (*oauthToken, error) {
	raw, err := m.fs.GetKey(m.storeKey())
	if err != nil {
		return nil, err
	}
	var tok oauthToken
	if err := json.Unmarshal([]byte(raw), &tok); err != nil {
		return nil, fmt.Errorf("parse stored grant: %w", err)
	}
	return &tok, nil
}

// parseJWTClaims decodes the payload segment of a JWT and returns its
// string-valued claims. Signature verification is intentionally skipped:
// the token was received directly from the provider's token endpoint over
// TLS, so its provenance is already established (the standard posture for
// a client consuming its own id_token).
func parseJWTClaims(token string) (map[string]string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("jwt: expected 3 segments, got %d", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("jwt: decode payload: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("jwt: parse payload: %w", err)
	}
	claims := make(map[string]string, len(raw))
	for k, v := range raw {
		if s, ok := v.(string); ok {
			claims[k] = s
		}
	}
	return claims, nil
}
