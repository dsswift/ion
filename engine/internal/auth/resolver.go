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
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

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
}

// oauthToken holds an OAuth access token along with its refresh token and expiry.
// Stored in the file store under the key "oauth:<provider>" as JSON.
type oauthToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
}

// StoredCredential describes a credential entry visible through ListStored.
type StoredCredential struct {
	Provider string
	Source   string // "keychain", "filestore", or "credentials.json"
}

// Resolver implements 5-level API key resolution for LLM providers.
type Resolver struct {
	config       *types.AuthConfig
	programmatic map[string]string // provider ID -> API key (Level 1)
}

// NewResolver creates a resolver with the given auth configuration.
// If config is nil, only environment variable and keychain resolution is available.
func NewResolver(config *types.AuthConfig) *Resolver {
	return &Resolver{
		config:       config,
		programmatic: make(map[string]string),
	}
}

// SetProgrammatic stores an API key for a provider in the in-process programmatic
// map. Keys set here take priority over all other resolution levels.
func (r *Resolver) SetProgrammatic(providerID, apiKey string) {
	r.programmatic[strings.ToLower(providerID)] = apiKey
}

// HasKey performs a lightweight check to determine if the given provider has
// any credentials available (programmatic, env var, keychain, file store, or
// legacy credentials.json). Unlike ResolveKey, it does not attempt an OAuth
// refresh. Returns whether credentials exist and the auth source description
// (e.g. "env", "filestore").
func (r *Resolver) HasKey(provider string) (bool, string) {
	provider = strings.ToLower(provider)
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: checking provider=%s", provider))

	// Level 1: Programmatic
	if key, ok := r.programmatic[provider]; ok && key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s found at level=programmatic", provider))
		return true, "programmatic"
	}
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: provider=%s level=programmatic miss", provider))

	// Level 2: Environment variables
	if resolveFromEnv(provider) != "" {
		utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s found at level=env", provider))
		return true, "env"
	}
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: provider=%s level=env miss", provider))

	// Level 3: Keychain
	serviceName := "ion-engine"
	if r.config != nil && r.config.SecureStore != nil && r.config.SecureStore.ServiceName != "" {
		serviceName = r.config.SecureStore.ServiceName
	}
	if key, err := GetKeychainPassword(serviceName, provider); err == nil && key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s found at level=keychain (service=%s)", provider, serviceName))
		return true, "keychain"
	}
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: provider=%s level=keychain miss", provider))

	// Level 4a: Encrypted file store
	fs := NewFileStore()
	if key, err := fs.GetKey(provider); err == nil && key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s found at level=filestore", provider))
		return true, "filestore"
	}
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: provider=%s level=filestore miss", provider))

	// Level 4b: OAuth token in file store
	if oauthRaw, err := fs.GetKey("oauth:" + provider); err == nil && oauthRaw != "" {
		utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s found at level=oauth", provider))
		return true, "oauth"
	}
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: provider=%s level=oauth miss", provider))

	// Level 4c: Legacy credentials.json
	if resolveFromCredentialsFile(provider) != "" {
		utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s found at level=credentials.json", provider))
		return true, "credentials.json"
	}
	utils.Debug("AuthResolver", fmt.Sprintf("HasKey: provider=%s level=credentials.json miss", provider))

	utils.Log("AuthResolver", fmt.Sprintf("HasKey: provider=%s no credentials found at any level", provider))
	return false, ""
}

// ResolveKey resolves an API key for the given provider using a 5-level chain:
//  1. Programmatic (keys set via SetProgrammatic)
//  2. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
//  3. Keychain (macOS: security find-generic-password)
//  4. Config file (~/.ion/credentials.json)
//  5. OAuth token refresh (if a stored refresh_token exists for the provider)
func (r *Resolver) ResolveKey(provider string) (string, error) {
	provider = strings.ToLower(provider)
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: resolving provider=%s", provider))

	// Level 1: Programmatic (in-process override, highest priority)
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s trying level=1 (programmatic)", provider))
	if key, ok := r.programmatic[provider]; ok && key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s resolved via programmatic (keyLen=%d)", provider, len(key)))
		return key, nil
	}

	// Level 2: Environment variables
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s trying level=2 (env)", provider))
	if key := resolveFromEnv(provider); key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s resolved via env (keyLen=%d)", provider, len(key)))
		return key, nil
	}

	// Level 3: Keychain
	serviceName := "ion-engine"
	if r.config != nil && r.config.SecureStore != nil && r.config.SecureStore.ServiceName != "" {
		serviceName = r.config.SecureStore.ServiceName
	}
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s trying level=3 (keychain, service=%s)", provider, serviceName))
	if key, err := GetKeychainPassword(serviceName, provider); err == nil && key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s resolved via keychain (keyLen=%d)", provider, len(key)))
		return key, nil
	}

	// Level 4a: Encrypted file store (~/.ion/credentials.enc)
	fs := NewFileStore()
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s trying level=4a (filestore)", provider))
	if key, err := fs.GetKey(provider); err == nil && key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s resolved via filestore (keyLen=%d)", provider, len(key)))
		return key, nil
	}

	// Level 4b: Plaintext config file (~/.ion/credentials.json) -- legacy fallback
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s trying level=4b (credentials.json)", provider))
	if key := resolveFromCredentialsFile(provider); key != "" {
		utils.Log("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s resolved via credentials.json (keyLen=%d)", provider, len(key)))
		return key, nil
	}

	// Level 5: OAuth token refresh
	// Look for a previously stored OAuth token with a refresh_token. If found and
	// the access token is expired (or absent), use the refresh_token to obtain a
	// new access token via the standard grant_type=refresh_token flow.
	utils.Debug("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s trying level=5 (oauth)", provider))
	if r.config != nil && r.config.OAuth != nil {
		if oauthCfg, ok := r.config.OAuth[provider]; ok {
			token, err := r.refreshOAuthToken(provider, oauthCfg, fs)
			if err == nil && token != "" {
				utils.Log("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s resolved via oauth (keyLen=%d)", provider, len(token)))
				return token, nil
			}
			utils.Log("auth", fmt.Sprintf("OAuth refresh failed for %s: %v", provider, err))
		}
	}

	utils.Error("AuthResolver", fmt.Sprintf("ResolveKey: provider=%s failed - no key found at any level", provider))
	return "", fmt.Errorf("no API key found for provider %q", provider)
}

// refreshOAuthToken attempts to refresh a stored OAuth token for the given provider.
// It reads the stored oauthToken from the file store. If the access token is still
// valid it is returned directly. If expired (or absent) and a refresh_token is
// present, a new access token is fetched from the token endpoint. The refreshed
// token is written back to the store before returning.
func (r *Resolver) refreshOAuthToken(provider string, cfg types.OAuthConfig, fs *FileStore) (string, error) {
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

	newTok, err := doRefreshTokenGrant(cfg.ClientID, tok.RefreshToken, cfg.TokenURL)
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
			utils.Log("auth", fmt.Sprintf("failed to persist refreshed token for %s: %v", provider, storeErr))
		}
	}

	utils.Log("AuthResolver", fmt.Sprintf("refreshOAuthToken: provider=%s refresh succeeded (newTokenLen=%d)", provider, len(newTok.AccessToken)))
	return newTok.AccessToken, nil
}

// doRefreshTokenGrant performs a standard OAuth2 refresh_token grant POST and
// returns the new token. It reuses the same http.Client pattern used in oauth.go.
func doRefreshTokenGrant(clientID, refreshToken, tokenURL string) (*oauthToken, error) {
	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("refresh token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("refresh token read error: %w", err)
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
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
	}
	if tokenResp.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	return tok, nil
}

// ListStored returns a list of credentials known to the resolver, drawn from the
// encrypted file store and the legacy credentials.json. Keychain entries are not
// enumerable via the security CLI without prompting, so they are not included.
func (r *Resolver) ListStored() []StoredCredential {
	var out []StoredCredential

	// Encrypted file store
	fs := NewFileStore()
	if creds, err := fs.readFile(); err == nil {
		for provider := range creds.Keys {
			// Skip internal oauth token entries; expose only plain provider keys.
			if strings.HasPrefix(provider, "oauth:") {
				continue
			}
			out = append(out, StoredCredential{Provider: provider, Source: "filestore"})
		}
	}

	// Legacy credentials.json
	home, err := os.UserHomeDir()
	if err == nil {
		path := filepath.Join(home, ".ion", "credentials.json")
		if data, err := os.ReadFile(path); err == nil {
			var legacyCreds map[string]string
			if err := json.Unmarshal(data, &legacyCreds); err == nil {
				for provider := range legacyCreds {
					out = append(out, StoredCredential{Provider: provider, Source: "credentials.json"})
				}
			}
		}
	}

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
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	path := filepath.Join(home, ".ion", "credentials.json")
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
