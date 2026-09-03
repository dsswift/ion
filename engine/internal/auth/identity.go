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
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
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
}

// ExpiringTokenProvider is the optional expiry-aware extension of
// TokenProvider. Consumers that rotate long-lived sockets use it to schedule a
// replacement before the bearer becomes invalid; ordinary callers keep using
// TokenProvider unchanged.
type ExpiringTokenProvider interface {
	GetTokenWithAudienceExpiry(ctx context.Context, scope, audience string) (token string, expiresAt time.Time, err error)
}

// RefreshableTokenProvider is the optional explicit-refresh extension of
// TokenProvider. It bypasses fresh cached and base-grant access tokens while
// retaining the provider's serialized refresh-token transaction. Consumers
// use it only when a downstream resource rejects a still-valid bearer token.
type RefreshableTokenProvider interface {
	ForceRefreshTokenWithAudienceExpiry(ctx context.Context, scope, audience string) (token string, expiresAt time.Time, err error)
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
	// Claims preserves every JSON-compatible claim from the verified id_token.
	Claims    map[string]any `json:"claims,omitempty"`
	expiresAt time.Time
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

	// refreshMu serializes the full stored-refresh-token transaction. Providers
	// may rotate a refresh token on every use; concurrent scoped requests must
	// not both spend the same old token and strand the durable identity.
	refreshMu sync.Mutex

	mu sync.Mutex
	// scopeCache holds minted access tokens keyed by scope+audience.
	// Access tokens are short-lived by design, so they live in memory
	// only; the durable refresh token is what persists (encrypted, on
	// disk).
	scopeCache map[string]oauthToken
	// identity is the verified id_token claims, cached after first resolution.
	identity *OperatorIdentity
	// identityResolved caches both present and absent state to avoid repeated
	// credential-store decryptions while signed out.
	identityResolved bool
	identityExpiry   time.Time
	verifier         *oidcVerifier
	// endpointsResolved marks a completed OIDC discovery pass (issuerUrl
	// config). Guarded by mu; a failed pass retries on the next call.
	endpointsResolved bool
	// renewing guards against launching more than one concurrent background
	// renewal from Identity()'s hot path. See kickBackgroundRenewal.
	renewing atomic.Bool
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
	nonce, err := generateNonce()
	if err != nil {
		return nil, fmt.Errorf("identity: generate login nonce: %w", err)
	}
	pkceCfg.Nonce = nonce

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
			if err := m.completeLogin(context.Background(), tok, nonce); err != nil {
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
		ClientID:       m.cfg.ClientID,
		AuthURL:        m.cfg.AuthorizationURL,
		TokenURL:       m.cfg.TokenURL,
		Scope:          strings.Join(m.cfg.Scopes, " "),
		Audience:       m.cfg.Audience,
		AudienceParam:  m.cfg.AudienceParameter,
		ExpectedIssuer: m.cfg.IssuerURL,
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

// CompleteLogin verifies a freshly granted token bundle before it persists it.
// The method never accepts claims decoded by a caller: only the configured OIDC
// verifier can create a durable operator grant.
func (m *IdentityManager) CompleteLogin(tok *TokenResponse) error {
	return m.completeLogin(context.Background(), tok, "")
}

func (m *IdentityManager) completeLogin(ctx context.Context, tok *TokenResponse, expectedNonce string) error {
	if tok == nil || tok.AccessToken == "" {
		return fmt.Errorf("identity: empty token response")
	}
	identity, err := m.verifyIdentity(ctx, tok.IDToken, expectedNonce)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "auth.identity", "operator identity verification failed", map[string]any{
			"provider": m.provider,
			"stage":    "login",
			"error":    err.Error(),
		})
		return err
	}
	if tok.RefreshToken == "" {
		utils.LogWithFields(utils.LevelError, "auth.identity", "login grant carries no refresh token; silent refresh unavailable", map[string]any{
			"provider": m.provider,
			"scope":    tok.Scope,
		})
	}
	stored := oauthToken{
		AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken,
		ExpiresAt: tok.ExpiresAt, IDToken: tok.IDToken, TokenType: tok.TokenType,
		Scope: tok.Scope, IdentityVersion: currentIdentityVersion,
		PersistedIdentity: identityToPersisted(identity),
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("identity: marshal token: %w", err)
	}
	if err := m.fs.SetKey(m.storeKey(), string(encoded)); err != nil {
		return fmt.Errorf("identity: persist token: %w", err)
	}

	m.mu.Lock()
	previous := cloneOperatorIdentity(m.identity)
	m.scopeCache = make(map[string]oauthToken)
	m.identity = identity
	m.identityExpiry = identity.expiresAt
	m.identityResolved = true
	if tok.Scope != "" {
		m.scopeCache[cacheKey(tok.Scope, m.cfg.Audience)] = stored
	}
	m.mu.Unlock()

	reason := "signed_in"
	if !operatorIdentityEqual(previous, identity) && previous != nil {
		reason = "claims_changed"
	}
	m.publishIdentity(identity, reason)
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "operator signed in", map[string]any{
		"provider": m.provider, "scope": tok.Scope,
		"has_refresh_token": tok.RefreshToken != "", "has_id_token": tok.IDToken != "",
	})
	return nil
}

func (m *IdentityManager) verifyIdentity(ctx context.Context, rawIDToken, expectedNonce string) (*OperatorIdentity, error) {
	m.mu.Lock()
	verifier := m.verifier
	m.mu.Unlock()
	if verifier == nil {
		var err error
		verifier, err = newOIDCVerifier(m.cfg.IssuerURL, m.cfg.ClientID)
		if err != nil {
			return nil, err
		}
		m.mu.Lock()
		if m.verifier == nil {
			m.verifier = verifier
		}
		verifier = m.verifier
		m.mu.Unlock()
	}
	identity, err := verifier.verify(ctx, rawIDToken, expectedNonce)
	if err != nil {
		return nil, err
	}
	identity.Provider = m.provider
	if m.cfg.AttributionClaim != "" {
		if attribution, ok := identity.Claims[m.cfg.AttributionClaim].(string); ok {
			identity.Attribution = attribution
		}
	}
	return identity, nil
}

// SeedVerifiedLoginForTest creates a version-one verified fixture for package
// tests outside auth. Production login paths must use CompleteLogin, which
// verifies the token first.
func (m *IdentityManager) SeedVerifiedLoginForTest(tok *TokenResponse, identity *OperatorIdentity) error {
	if tok == nil || tok.AccessToken == "" {
		return fmt.Errorf("identity: empty test token response")
	}
	stored := oauthToken{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, ExpiresAt: tok.ExpiresAt, IDToken: tok.IDToken, TokenType: tok.TokenType, Scope: tok.Scope, IdentityVersion: currentIdentityVersion, PersistedIdentity: identityToPersisted(identity)}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return fmt.Errorf("identity: marshal test token: %w", err)
	}
	if err := m.fs.SetKey(m.storeKey(), string(encoded)); err != nil {
		return fmt.Errorf("identity: persist test token: %w", err)
	}
	identity = cloneOperatorIdentity(identity)
	if identity != nil {
		identity.Provider = m.provider
	}
	m.mu.Lock()
	m.scopeCache = make(map[string]oauthToken)
	m.identity = identity
	m.identityExpiry = time.Time{}
	m.identityResolved = true
	if tok.Scope != "" {
		m.scopeCache[cacheKey(tok.Scope, m.cfg.Audience)] = stored
	}
	m.mu.Unlock()
	return nil
}

// SignedIn reports whether a persisted operator identity grant exists. Any
// versioned grant counts: a below-current-version grant is a signed-in operator
// awaiting a silent reconcile, not a signed-out one. A grant that carries only
// the identity snapshot (no version, e.g. a future downgrade-tolerant blob)
// also counts.
func (m *IdentityManager) SignedIn() bool {
	stored, err := m.loadStored()
	if err != nil {
		return false
	}
	return stored.IdentityVersion >= 1 || stored.PersistedIdentity != nil
}

// ValidateGrant proves the persisted operator grant is usable now. A current,
// fresh grant validates from its identity snapshot without network I/O; a stale
// or below-current-version grant is silently refreshed, its fresh id_token
// verified, and re-persisted at the current version. A persisted but revoked or
// unrefreshable grant is therefore not treated as authenticated. It shares the
// renewNow mechanism, so a required-identity session gate and the background
// renewer prove the grant the same way.
func (m *IdentityManager) ValidateGrant(ctx context.Context) error {
	return m.renewNow(ctx, false)
}

// SignOut deletes the persisted grant and clears all cached tokens.
func (m *IdentityManager) SignOut() error {
	m.mu.Lock()
	m.scopeCache = make(map[string]oauthToken)
	m.identity = nil
	m.identityExpiry = time.Time{}
	m.identityResolved = true
	m.mu.Unlock()

	if err := m.fs.DeleteKey(m.storeKey()); err != nil {
		return fmt.Errorf("identity: delete stored grant: %w", err)
	}
	m.publishIdentity(nil, "signed_out")
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
	token, _, err := m.GetTokenWithAudienceExpiry(ctx, scope, audience)
	return token, err
}

// GetTokenWithAudienceExpiry returns the token and exact provider expiry for
// consumers that need to rotate a connection before relay enforcement closes it.
func (m *IdentityManager) GetTokenWithAudienceExpiry(ctx context.Context, scope, audience string) (string, time.Time, error) {
	return m.getTokenWithAudienceExpiry(ctx, scope, audience, false)
}

// ForceRefreshTokenWithAudienceExpiry implements RefreshableTokenProvider. It
// bypasses fresh cached and base-grant access tokens, but uses refreshMu so
// concurrent calls still serialize refresh-token rotation and persistence.
func (m *IdentityManager) ForceRefreshTokenWithAudienceExpiry(ctx context.Context, scope, audience string) (string, time.Time, error) {
	return m.getTokenWithAudienceExpiry(ctx, scope, audience, true)
}

func (m *IdentityManager) getTokenWithAudienceExpiry(ctx context.Context, scope, audience string, forceRefresh bool) (string, time.Time, error) {
	if err := ctx.Err(); err != nil {
		return "", time.Time{}, err
	}
	if audience == "" {
		audience = m.cfg.Audience
	}
	key := cacheKey(scope, audience)

	m.mu.Lock()
	cached, ok := m.scopeCache[key]
	m.mu.Unlock()
	if !forceRefresh && ok && m.tokenFresh(cached) {
		return cached.AccessToken, cached.ExpiresAt, nil
	}

	// Serialize load → refresh → rotation persistence → cache publication.
	// Re-check after acquiring the lock because another waiter may have minted
	// this exact resource while this goroutine was blocked.
	m.refreshMu.Lock()
	defer m.refreshMu.Unlock()
	m.mu.Lock()
	cached, ok = m.scopeCache[key]
	m.mu.Unlock()
	if !forceRefresh && ok && m.tokenFresh(cached) {
		return cached.AccessToken, cached.ExpiresAt, nil
	}

	stored, err := m.loadStored()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("identity: no signed-in operator for provider %q: %w", m.provider, err)
	}

	// The base grant's own access token satisfies a request for the base
	// scope (empty scope, or an exact match) under the default audience
	// while it is still fresh.
	if !forceRefresh && (scope == "" || scope == stored.Scope) && audience == m.cfg.Audience && m.tokenFresh(*stored) {
		return stored.AccessToken, stored.ExpiresAt, nil
	}

	if stored.RefreshToken == "" {
		return "", time.Time{}, fmt.Errorf("identity: stored grant for provider %q has no refresh token; interactive re-login required", m.provider)
	}

	if err := m.resolveEndpoints(); err != nil {
		return "", time.Time{}, err
	}
	newTok, err := doRefreshTokenGrant(m.cfg.ClientID, stored.RefreshToken, m.cfg.TokenURL, scope, audience, m.cfg.AudienceParameter)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("identity: mint token for scope %q (audience %q): %w", scope, audience, err)
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
		"force_refresh":   forceRefresh,
	})
	return newTok.AccessToken, newTok.ExpiresAt, nil
}

// Identity returns the cached verified identity. It never performs network I/O
// on its own, and it never discards a known identity because a freshness window
// lapsed: the operator's identity is a stable fact, not a time-boxed one. When
// the cached id_token has aged past its expiry, Identity keeps serving the known
// identity and kicks a non-blocking background renewal; only an explicit
// SignOut clears the identity.
func (m *IdentityManager) Identity() *OperatorIdentity {
	m.mu.Lock()
	if m.identityResolved {
		identity := cloneOperatorIdentity(m.identity)
		expiresAt := m.identityExpiry
		m.mu.Unlock()
		if identity != nil && !expiresAt.IsZero() && time.Now().After(expiresAt) {
			m.kickBackgroundRenewal()
		}
		return identity
	}
	m.mu.Unlock()

	stored, err := m.loadStored()
	if err != nil {
		m.cacheIdentity(nil)
		return nil
	}

	// v2 grant: hydrate the verified identity snapshot without any network I/O,
	// then renew in the background if the id_token's freshness window has lapsed.
	if stored.PersistedIdentity != nil {
		identity := persistedToIdentity(stored.PersistedIdentity)
		identity.Provider = m.provider
		m.cacheIdentity(identity)
		if !m.tokenFresh(*stored) || time.Now().After(identity.expiresAt) {
			m.kickBackgroundRenewal()
		}
		return cloneOperatorIdentity(identity)
	}

	// v0/v1 grant: verify the stored id_token to derive the identity.
	if stored.IDToken != "" {
		identity, verr := m.verifyIdentity(context.Background(), stored.IDToken, "")
		if verr == nil {
			m.cacheIdentity(identity)
			return cloneOperatorIdentity(identity)
		}
		utils.LogWithFields(utils.LevelWarn, "auth.identity", "stored id_token unusable; renewing from refresh token", map[string]any{
			"provider": m.provider, "stage": "stored_grant", "error": verr.Error(),
		})
	}

	// No usable snapshot or id_token. A refresh token can still restore identity;
	// renew in the background and report last-known (nil) until it completes. Do
	// not cache nil here — a concurrent renewal must be able to fill the cache.
	if stored.RefreshToken != "" {
		m.kickBackgroundRenewal()
		return nil
	}
	m.cacheIdentity(nil)
	return nil
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
