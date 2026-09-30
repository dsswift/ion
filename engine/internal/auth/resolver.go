// Package auth implements the Ion Engine authentication resolver.
// Port of engine/src/auth/ (321 lines).
package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// keychainLookup is the indirection tests substitute to exercise the
// keychain resolution level without touching the real OS credential store.
// Production code always uses the platform GetKeychainPassword.
var keychainLookup = GetKeychainPassword

// Well-known environment variable names for provider API keys.
var providerEnvVars = map[string][]string{
	"anthropic":  {"ANTHROPIC_API_KEY"},
	"openai":     {"OPENAI_API_KEY"},
	"google":     {"GOOGLE_API_KEY", "GEMINI_API_KEY"},
	"aws":        {"AWS_ACCESS_KEY_ID"},
	"azure":      {"AZURE_OPENAI_API_KEY", "AZURE_API_KEY"},
	"mistral":    {"MISTRAL_API_KEY"},
	"cohere":     {"COHERE_API_KEY"},
	"groq":       {"GROQ_API_KEY"},
	"openrouter": {"OPENROUTER_API_KEY"},
	"together":   {"TOGETHER_API_KEY"},
	"fireworks":  {"FIREWORKS_API_KEY"},
	"cerebras":   {"CEREBRAS_API_KEY"},
	"xai":        {"XAI_API_KEY"},
	"deepseek":   {"DEEPSEEK_API_KEY"},
	// foundry was constructor-only (foundry.go) before this entry: the
	// constructor tried ANTHROPIC_FOUNDRY_API_KEY, falling back to
	// ANTHROPIC_API_KEY. This makes that same fallback resolvable through
	// ResolveKey/HasKey so the resolver, not the constructor, is the single
	// path (baseline.md §1.2).
	"foundry": {"ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_API_KEY"},
}

// oauthToken holds an OAuth access token along with its refresh token and expiry.
// Stored in the file store under the key "oauth:<provider>" as JSON.
// For OIDC identity providers the entry also carries the id_token (identity
// claims for user attribution) and the scope/token_type of the stored grant.
// All added fields are omitempty, so pre-existing stored entries decode
// unchanged.
type oauthToken struct {
	AccessToken     string    `json:"access_token"`
	RefreshToken    string    `json:"refresh_token,omitempty"`
	ExpiresAt       time.Time `json:"expires_at,omitempty"`
	IDToken         string    `json:"id_token,omitempty"`
	TokenType       string    `json:"token_type,omitempty"`
	Scope           string    `json:"scope,omitempty"`
	IdentityVersion int       `json:"identity_version,omitempty"`
	// PersistedIdentity is the verified operator identity captured at grant
	// time (schema v2). It lets the engine present the operator's identity
	// immediately at startup and after an id_token's freshness window lapses,
	// without re-verifying against the IdP on a hot path. Absent on v0/v1
	// grants, which reconcile up to the current version on the next load.
	PersistedIdentity *persistedIdentity `json:"identity,omitempty"`
}

// StoredCredential describes a credential entry visible through ListStored.
type StoredCredential struct {
	Provider string
	Source   string // "keychain", "filestore", or "credentials.json"
}

// Resolver implements 5-level API key resolution for LLM providers, above
// which sits the key a Provider Subscription lookup applied (Level 0).
type Resolver struct {
	config       *types.AuthConfig
	programmatic map[string]string // provider ID -> API key (Level 1)

	// subscription holds looked-up keys (Level 0). It changes at runtime
	// as identities sign in and out, so it has its own lock.
	subscriptionMu sync.RWMutex
	subscription   map[string]string
}

// NewResolver creates a resolver with the given auth configuration.
// If config is nil, only environment variable and keychain resolution is available.
func NewResolver(config *types.AuthConfig) *Resolver {
	if config != nil {
		SetNegativeCacheTTL(config.HasKeyNegativeCacheSeconds)
	}
	return &Resolver{
		config:       config,
		programmatic: make(map[string]string),
		subscription: make(map[string]string),
	}
}

// SetProgrammatic stores an API key for a provider in the in-process programmatic
// map. Keys set here take priority over all other resolution levels.
func (r *Resolver) SetProgrammatic(providerID, apiKey string) {
	r.programmatic[strings.ToLower(providerID)] = apiKey
	// A negative cached before this call would now be wrong.
	InvalidateHasKey(providerID)
}

// HasKey performs a lightweight check to determine if the given provider has
// any credentials available (programmatic, env var, keychain, file store, or
// legacy credentials.json). Unlike ResolveKey, it does not attempt an OAuth
// refresh. Returns whether credentials exist and the auth source description
// (e.g. "env", "filestore"). This is the unattributed ("" subject) case --
// the KeyHaver interface's own shape has no subject parameter, so every
// existing caller (server-side listing with no principal, the routing
// fall-through path via keys.HasKey) is the process-wide question this
// answers, byte for byte unchanged (B-21).
func (r *Resolver) HasKey(provider string) (bool, string) {
	return r.HasKeyForSubject("", provider)
}

// HasKeyForSubject is HasKey generalized over subject (child 07, R-14): the
// negative-result cache is keyed by (subject, provider) rather than provider
// alone, so a negative cached while answering for one principal's
// CredentialContext.HasCredential fall-through never masks a different
// principal's cache entry for the same provider. The five resolution levels
// below are process-wide and do not themselves vary by subject -- only the
// CACHE KEY does, which is what keeps the fall-through answer isolated per
// principal rather than shared process-wide the way the pre-child-07 cache
// was.
func (r *Resolver) HasKeyForSubject(subject, provider string) (bool, string) {
	provider = strings.ToLower(provider)

	// A cached negative skips levels 3-4c, which are the I/O ones (keychain
	// lookup, two file-store reads, credentials.json). Only negatives are
	// cached: serving a stale positive would keep handing out a credential the
	// operator revoked. Every credential write invalidates this, so the TTL is
	// a backstop rather than the mechanism.
	if hasNegative(subject, provider) {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key negative cache hit", map[string]any{"subject": subject, "provider": provider})
		return false, ""
	}

	utils.LogWithFields(utils.LevelDebug, "auth", "has key checking", map[string]any{"subject": subject, "provider": provider})

	// Level 0: Provider Subscription lookup
	if r.subscriptionKey(provider) != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": SourceSubscription})
		return true, SourceSubscription
	}

	// Level 1: Programmatic
	if key, ok := r.programmatic[provider]; ok && key != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "programmatic"})
		return true, "programmatic"
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "has key miss", map[string]any{"provider": provider, "reason": "programmatic"})

	// Level 2: Environment variables. A provider with a declared multi-value
	// set (Bedrock, Vertex) reports true only when its whole required set is
	// present -- otherwise a "configured" Bedrock with a missing secret would
	// report keyless to routing (child 06 depends on this).
	if _, ok := ResolveProviderEnv(provider); ok {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "env"})
		return true, "env"
	}
	if _, isMultiValue := providerEnvSets[provider]; !isMultiValue && resolveFromEnv(provider) != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "env"})
		return true, "env"
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "has key miss", map[string]any{"provider": provider, "reason": "env"})

	// Level 3: Keychain
	serviceName := "ion-engine"
	if r.config != nil && r.config.SecureStore != nil && r.config.SecureStore.ServiceName != "" {
		serviceName = r.config.SecureStore.ServiceName
	}
	if key, err := keychainLookup(serviceName, provider); err == nil && key != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "keychain"})
		return true, "keychain"
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "has key miss", map[string]any{"provider": provider, "reason": "keychain"})

	// Level 4a: Encrypted file store
	fs := NewFileStore()
	if key, err := fs.GetKey(provider); err == nil && key != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "filestore"})
		return true, "filestore"
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "has key miss", map[string]any{"provider": provider, "reason": "filestore"})

	// Level 4b: OAuth token in file store
	if oauthRaw, err := fs.GetKey("oauth:" + provider); err == nil && oauthRaw != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "oauth"})
		return true, "oauth"
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "has key miss", map[string]any{"provider": provider, "reason": "oauth"})

	// Level 4c: Legacy credentials.json
	if resolveFromCredentialsFile(provider) != "" {
		utils.LogWithFields(utils.LevelDebug, "auth", "has key found", map[string]any{"provider": provider, "reason": "credentials.json"})
		return true, "credentials.json"
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "has key miss", map[string]any{"provider": provider, "reason": "credentials.json"})

	rememberNegative(subject, provider)
	utils.LogWithFields(utils.LevelInfo, "auth", "has key no credentials found", map[string]any{"subject": subject, "provider": provider})
	return false, ""
}

// ResolveProviderValues resolves the multi-value environment set for a
// provider (Bedrock's access key/secret/session token/region, Vertex's
// token/project) via auth.Resolver, so a caller that needs the whole set does
// not reach past the resolver into the environment directly. ResolveKey's
// signature is unchanged; this is an additional accessor for providers whose
// credential is not a single string. Returns (nil, false) for a provider with
// no declared set -- ResolveKey answers those.
func (r *Resolver) ResolveProviderValues(provider string) (*ProviderEnvValues, bool) {
	return ResolveProviderEnv(provider)
}

// ResolveKey resolves an API key for the given provider using a 5-level chain,
// after the key a Provider Subscription lookup applied (Level 0):
//  1. Programmatic (keys set via SetProgrammatic)
//  2. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
//  3. Keychain (macOS: security find-generic-password)
//  4. Config file (~/.ion/credentials.json)
//  5. OAuth token refresh (if a stored refresh_token exists for the provider)
func (r *Resolver) ResolveKey(provider string) (string, error) {
	provider = strings.ToLower(provider)
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key", map[string]any{"provider": provider})

	// Level 0: Provider Subscription lookup (outranks the manual levels)
	if key := r.subscriptionKey(provider); key != "" {
		utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via subscription", map[string]any{"provider": provider, "count": len(key)})
		return key, nil
	}

	// Level 1: Programmatic (in-process override, highest priority)
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key trying programmatic", map[string]any{"provider": provider})
	if key, ok := r.programmatic[provider]; ok && key != "" {
		utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via programmatic", map[string]any{"provider": provider, "count": len(key)})
		return key, nil
	}

	// Level 2: Environment variables
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key trying env", map[string]any{"provider": provider})
	if key := resolveFromEnv(provider); key != "" {
		utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via env", map[string]any{"provider": provider, "count": len(key)})
		return key, nil
	}

	// Level 3: Keychain
	serviceName := "ion-engine"
	if r.config != nil && r.config.SecureStore != nil && r.config.SecureStore.ServiceName != "" {
		serviceName = r.config.SecureStore.ServiceName
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key trying keychain", map[string]any{"provider": provider})
	if key, err := keychainLookup(serviceName, provider); err == nil && key != "" {
		utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via keychain", map[string]any{"provider": provider, "count": len(key)})
		return key, nil
	}

	// Level 4a: Encrypted file store (~/.ion/credentials.enc)
	fs := NewFileStore()
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key trying filestore", map[string]any{"provider": provider})
	if key, err := fs.GetKey(provider); err == nil && key != "" {
		utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via filestore", map[string]any{"provider": provider, "count": len(key)})
		return key, nil
	}

	// Level 4b: Plaintext config file (~/.ion/credentials.json) -- legacy fallback
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key trying credentials.json", map[string]any{"provider": provider})
	if key := resolveFromCredentialsFile(provider); key != "" {
		utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via credentials.json", map[string]any{"provider": provider, "count": len(key)})
		return key, nil
	}

	// Level 5: OAuth token refresh
	// Look for a previously stored OAuth token with a refresh_token. If found and
	// the access token is expired (or absent), use the refresh_token to obtain a
	// new access token via the standard grant_type=refresh_token flow.
	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key trying oauth", map[string]any{"provider": provider})
	if r.config != nil && r.config.OAuth != nil {
		if oauthCfg, ok := r.config.OAuth[provider]; ok {
			token, err := r.refreshOAuthToken(provider, oauthCfg, fs)
			if err == nil && token != "" {
				utils.LogWithFields(utils.LevelInfo, "auth", "resolve key resolved via oauth", map[string]any{"provider": provider, "count": len(token)})
				return token, nil
			}
			utils.LogWithFields(utils.LevelInfo, "auth", "oauth refresh failed", map[string]any{"provider": provider, "error": err.Error()})
		}
	}

	utils.LogWithFields(utils.LevelDebug, "auth", "resolve key failed no key found", map[string]any{"provider": provider})
	return "", fmt.Errorf("no API key found for provider %q", provider)
}

// refreshOAuthToken attempts to refresh a stored OAuth token for the given provider.
// It reads the stored oauthToken from the file store. If the access token is still
// valid it is returned directly. If expired (or absent) and a refresh_token is
// present, a new access token is fetched from the token endpoint. The refreshed
// token is written back to the store before returning.
func (r *Resolver) refreshOAuthToken(provider string, cfg types.OAuthConfig, fs *FileStore) (string, error) {
	cfg, err := withResolvedClientID(provider, cfg)
	if err != nil {
		return "", err
	}
	storeKey := "oauth:" + provider

	raw, err := fs.GetKey(storeKey)
	if err != nil {
		// No stored token; nothing to refresh.
		return "", fmt.Errorf("no stored OAuth token for provider %q", provider)
	}

	var tok oauthToken
	if err := json.Unmarshal([]byte(raw), &tok); err != nil {
		return "", fmt.Errorf("parse stored OAuth token: %w", err)
	}

	// If the access token is still valid, return it immediately.
	if tok.AccessToken != "" && !tok.ExpiresAt.IsZero() && time.Now().Before(tok.ExpiresAt) {
		return tok.AccessToken, nil
	}

	// No valid access token; attempt refresh if we have a refresh_token.
	if tok.RefreshToken == "" {
		return "", fmt.Errorf("no refresh_token stored for provider %q", provider)
	}

	if cfg.TokenURL == "" {
		return "", fmt.Errorf("no token URL configured for provider %q", provider)
	}

	// Empty scope preserves the original grant's scope (RFC 6749 §6: omitted
	// scope means "same as the original request"). Per-scope minting for
	// downstream resources goes through IdentityManager.GetToken instead.
	newTok, err := doRefreshTokenGrant(cfg.ClientID, tok.RefreshToken, cfg.TokenURL, "", "", "")
	if err != nil {
		return "", err
	}

	// Preserve the refresh_token from the response if provided, otherwise keep
	// the existing one (some servers rotate, some do not).
	if newTok.RefreshToken == "" {
		newTok.RefreshToken = tok.RefreshToken
	}

	// Persist the refreshed token.
	encoded, err := json.Marshal(newTok)
	if err == nil {
		if storeErr := fs.SetKey(storeKey, string(encoded)); storeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "auth", "failed to persist refreshed token", map[string]any{"provider": provider, "error": storeErr.Error()})
		}
	}

	utils.LogWithFields(utils.LevelInfo, "auth", "refresh oauth token succeeded", map[string]any{"provider": provider, "count": len(newTok.AccessToken)})
	return newTok.AccessToken, nil
}

// doRefreshTokenGrant performs a standard OAuth2 refresh_token grant POST and
// returns the new token. It reuses the same http.Client pattern used in oauth.go.
// scope, when non-empty, is sent with the grant (RFC 6749 §6) to mint an
// access token for a different resource than the original grant -- the
// mechanism behind per-scope tokens for downstream APIs (one refresh token,
// many audiences). When empty, the provider returns a token with the
// original grant's scope. audience, when non-empty, is sent under
// audienceParam's dialect ("audience" default, "resource" for RFC 8707)
// for IdPs that bind tokens to an explicit audience rather than encoding
// it in the scope string.
func doRefreshTokenGrant(clientID, refreshToken, tokenURL, scope, audience, audienceParam string) (*oauthToken, error) {
	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}
	if scope != "" {
		form.Set("scope", scope)
	}
	if audience != "" {
		form.Set(audienceParamName(audienceParam), audience)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("refresh token request failed: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "auth", "refresh oauth token response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("refresh token read error: %w", err)
	}

	var tokenResp wireTokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("refresh token parse error: %w", err)
	}

	if tokenResp.Error != "" {
		return nil, fmt.Errorf("refresh token error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("no access token in refresh response")
	}

	tok := &oauthToken{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		IDToken:      tokenResp.IDToken,
		TokenType:    tokenResp.TokenType,
		Scope:        tokenResp.Scope,
	}
	if tokenResp.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	return tok, nil
}

// ListStored returns a list of credentials known to the resolver, drawn from the
// encrypted file store and the legacy credentials.json. Keychain entries are not
// enumerable via the security CLI without prompting, so they are not included.
// ListStored returns a list of credentials known to the resolver, drawn from the
// encrypted file store and the legacy plaintext credentials.json. This is the
// unattributed ("" subject) view -- ListStoredFor is the principal-aware
// counterpart (child 08, R-38).
func (r *Resolver) ListStored() []StoredCredential {
	return r.ListStoredFor("")
}

// ListStoredFor returns the credentials in subject's own partition (child 08,
// R-38): an attributed principal sees only what THEY stored, never another
// principal's entries and never the unattributed partition's. subject ""
// preserves ListStored's exact pre-existing behavior byte for byte
// (encrypted file store entries, minus internal oauth: grants, plus the
// legacy credentials.json -- which is unattributed-only and never
// partitioned, B-09).
func (r *Resolver) ListStoredFor(subject string) []StoredCredential {
	var out []StoredCredential

	fs := NewFileStore()
	if names, err := fs.ListFor(subject); err == nil {
		for _, name := range names {
			// Skip internal oauth token and subscription cache entries;
			// expose only plain provider keys.
			if strings.HasPrefix(name, "oauth:") || strings.HasPrefix(name, SubscriptionCachePrefix) {
				continue
			}
			out = append(out, StoredCredential{Provider: name, Source: "filestore"})
		}
	}

	// Legacy credentials.json is unattributed-only (B-09): it predates this
	// program entirely and is never written to by any partitioned path, so
	// it only ever appears in the unattributed listing.
	if subject == "" {
		if dir := utils.IonDir(); dir != "" {
			path := filepath.Join(dir, "credentials.json")
			if data, err := os.ReadFile(path); err == nil {
				var legacyCreds map[string]string
				if err := json.Unmarshal(data, &legacyCreds); err == nil {
					for provider := range legacyCreds {
						out = append(out, StoredCredential{Provider: provider, Source: "credentials.json"})
					}
				}
			}
		}
	}

	utils.LogWithFields(utils.LevelDebug, "auth", "list stored credentials", map[string]any{"subject": subject, "count": len(out)})
	return out
}

// resolveFromEnv checks environment variables for the given provider.
func resolveFromEnv(provider string) string {
	envVars, ok := providerEnvVars[provider]
	if !ok {
		// Try generic pattern: <PROVIDER>_API_KEY
		generic := strings.ToUpper(provider) + "_API_KEY"
		if v := os.Getenv(generic); v != "" {
			return v
		}
		return ""
	}

	for _, env := range envVars {
		if v := os.Getenv(env); v != "" {
			return v
		}
	}
	return ""
}

// credentialsFile is a JSON file at ~/.ion/credentials.json with
// structure: { "provider_name": "api_key_value", ... }
func resolveFromCredentialsFile(provider string) string {
	dir := utils.IonDir()
	if dir == "" {
		return ""
	}
	path := filepath.Join(dir, "credentials.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	var creds map[string]string
	if err := json.Unmarshal(data, &creds); err != nil {
		return ""
	}

	return creds[provider]
}
