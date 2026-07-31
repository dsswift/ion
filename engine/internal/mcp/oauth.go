package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/utils"
)

// tokenRefreshTimeout bounds a refresh_token exchange. A refresh runs inline
// on the connect path, so a hung token endpoint would stall session start.
const tokenRefreshTimeout = 30 * time.Second

// OAuthToken holds an OAuth 2.0 access token and optional refresh token.
type OAuthToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	TokenType    string    `json:"token_type"`
	ExpiresAt    time.Time `json:"expires_at"`
	Scope        string    `json:"scope,omitempty"`
}

// OAuthConfig holds the OAuth 2.0 configuration for an MCP server.
type OAuthConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	AuthURL      string `json:"auth_url"`
	TokenURL     string `json:"token_url"`
	Scope        string `json:"scope,omitempty"`
	RedirectURI  string `json:"redirect_uri,omitempty"`
	UsePKCE      bool   `json:"use_pkce,omitempty"`
}

// OAuthStore manages per-server OAuth tokens with file persistence.
type OAuthStore struct {
	mu     sync.RWMutex
	tokens map[string]*OAuthToken
	path   string
}

// NewOAuthStore creates a token store backed by ~/.ion/mcp-tokens.json.
func NewOAuthStore() *OAuthStore {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	storePath := filepath.Join(home, ".ion", "mcp-tokens.json")

	store := &OAuthStore{
		tokens: make(map[string]*OAuthToken),
		path:   storePath,
	}
	store.load()
	return store
}

// GetToken returns a stored token for the server, or nil if missing/expired.
func (s *OAuthStore) GetToken(serverName string) *OAuthToken {
	s.mu.RLock()
	defer s.mu.RUnlock()
	tok, ok := s.tokens[serverName]
	if !ok {
		return nil
	}
	if IsExpired(tok) {
		return nil
	}
	return tok
}

// SetToken stores a token for the server and persists to disk.
func (s *OAuthStore) SetToken(serverName string, token *OAuthToken) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[serverName] = token
	s.save()
}

// DeleteToken removes a token for the server and persists to disk.
func (s *OAuthStore) DeleteToken(serverName string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tokens, serverName)
	s.save()
}

// RefreshToken uses the refresh_token grant to obtain a new access token.
func (s *OAuthStore) RefreshToken(serverName string, config *OAuthConfig) (*OAuthToken, error) {
	s.mu.RLock()
	existing := s.tokens[serverName]
	s.mu.RUnlock()

	if existing == nil || existing.RefreshToken == "" {
		return nil, fmt.Errorf("no refresh token available for %s", serverName)
	}
	if config.TokenURL == "" {
		// Without a token endpoint the refresh cannot be attempted at all.
		// Naming the remediation here keeps the failure self-explaining in
		// engine.jsonl instead of surfacing as a bare POST error to "".
		return nil, fmt.Errorf("no token endpoint known for %s; run `ion mcp login %s` or set mcpServers.%s.oauth.token_url", serverName, serverName, serverName)
	}

	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {existing.RefreshToken},
		"client_id":     {config.ClientID},
	}
	if config.ClientSecret != "" {
		form.Set("client_secret", config.ClientSecret)
	}

	// Routed through the shared client so an enterprise proxy / custom CA
	// applies (D-018); http.PostForm would bypass the configured transport.
	client := *network.GetHTTPClient()
	client.Timeout = tokenRefreshTimeout
	resp, err := client.Post(config.TokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("refresh token request: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "refresh response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	if resp.StatusCode >= 400 {
		// The provider's error body names the actual cause (expired or revoked
		// refresh token, unknown client, scope change). Dropping it leaves only
		// a status code, which is not enough to act on.
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2048))
		if readErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "refresh error body read failed", map[string]any{"serverName": serverName, "error": readErr.Error()})
		}
		utils.LogWithFields(utils.LevelError, "mcp.oauth", "refresh token rejected by provider", map[string]any{
			"serverName": serverName, "status": resp.StatusCode, "tokenUrl": config.TokenURL, "body": string(body),
		})
		return nil, fmt.Errorf("refresh token failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}

	token := &OAuthToken{
		AccessToken: tokenResp.AccessToken,
		TokenType:   tokenResp.TokenType,
		ExpiresAt:   time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second),
		Scope:       tokenResp.Scope,
	}
	if tokenResp.RefreshToken != "" {
		token.RefreshToken = tokenResp.RefreshToken
	} else {
		token.RefreshToken = existing.RefreshToken
	}

	s.SetToken(serverName, token)
	return token, nil
}

// IsExpired checks if a token is expired, with a 60-second safety buffer.
func IsExpired(token *OAuthToken) bool {
	if token == nil {
		return true
	}
	return time.Now().After(token.ExpiresAt.Add(-60 * time.Second))
}

func (s *OAuthStore) save() {
	data, err := json.MarshalIndent(s.tokens, "", "  ")
	if err != nil {
		utils.LogWithFields(utils.LevelError, "mcp.oauth", "save marshal failed", map[string]any{"path": s.path, "error": err.Error()})
		return
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "save mkdir failed", map[string]any{"path": dir, "error": err.Error()})
		return
	}
	if err := os.WriteFile(s.path, data, 0600); err != nil {
		utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "save write failed", map[string]any{"path": s.path, "error": err.Error()})
	}
}

func (s *OAuthStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		// A real read error (not simply "no token file yet") is worth a log —
		// it means every OAuth server silently re-authenticates.
		if !errors.Is(err, os.ErrNotExist) {
			utils.LogWithFields(utils.LevelError, "mcp.oauth", "token store read failed", map[string]any{"path": s.path, "error": err.Error()})
		}
		return
	}
	var tokens map[string]*OAuthToken
	if err := json.Unmarshal(data, &tokens); err != nil {
		// Corrupt token file: without a log every stored token silently
		// vanishes and every OAuth server re-auths or 401s.
		utils.LogWithFields(utils.LevelError, "mcp.oauth", "token store unmarshal failed; stored tokens ignored", map[string]any{"path": s.path, "error": err.Error()})
		return
	}
	s.tokens = tokens
}

// getOAuthStore returns the package-level singleton OAuthStore instance.
// Multiple MCP connections share one store to avoid concurrent file I/O.
var (
	globalOAuthStore     *OAuthStore
	globalOAuthStoreOnce sync.Once
)

func getOAuthStore() *OAuthStore {
	globalOAuthStoreOnce.Do(func() { globalOAuthStore = NewOAuthStore() })
	return globalOAuthStore
}

// resolveOAuthHeaders returns auth headers for a server, refreshing if needed.
//
// oauthConfig is the operator's explicit engine.json `oauth` block, or nil.
// When nil, a stored client registration (from `ion mcp login`, which may have
// been created by dynamic registration) supplies the refresh endpoints — that
// is what lets a zero-config `mcpServers` entry carry a token at all. Before
// the login path existed, a nil config meant "no auth possible"; now it means
// "no auth CONFIGURED", which is not the same thing.
//
// Returns nil when no token is available, which is not necessarily an error:
// a server that requires no auth is the common case. Connect proceeds, and a
// server that does require auth answers 401 with the remediation Connect adds.
func resolveOAuthHeaders(serverName string, oauthConfig *OAuthConfig) map[string]string {
	effective := oauthConfig
	if effective == nil {
		// No explicit block: fall back to what a completed login stored.
		reg := getClientStore().Get(serverName)
		if reg == nil {
			utils.LogWithFields(utils.LevelDebug, "mcp.oauth", "no oauth config and no stored client registration; connecting unauthenticated", map[string]any{"serverName": serverName})
			return nil
		}
		effective = &OAuthConfig{
			ClientID:     reg.ClientID,
			ClientSecret: reg.ClientSecret,
			AuthURL:      reg.AuthURL,
			TokenURL:     reg.TokenURL,
			Scope:        reg.Scope,
			RedirectURI:  reg.RedirectURI,
			UsePKCE:      true,
		}
		utils.LogWithFields(utils.LevelDebug, "mcp.oauth", "using stored client registration for token resolution", map[string]any{
			"serverName": serverName, "clientId": reg.ClientID,
		})
	}

	store := getOAuthStore()
	token := store.GetToken(serverName)

	// Try refresh if token is expired but refresh token exists.
	if token == nil {
		var err error
		token, err = store.RefreshToken(serverName, effective)
		if err != nil {
			// Refresh failure: the connection proceeds unauthenticated, the
			// server 401s, and every tool disappears. Log so this is not silent.
			utils.LogWithFields(utils.LevelError, "mcp.oauth", "token refresh failed; connecting without auth", map[string]any{"serverName": serverName, "error": err.Error()})
			return nil
		}
	}

	if token == nil {
		// No stored or refreshed token — connect unauthenticated. Warn so a
		// missing token is visible when the server subsequently rejects calls.
		utils.LogWithFields(utils.LevelWarn, "mcp.oauth", "no oauth token available; connecting without auth", map[string]any{"serverName": serverName})
		return nil
	}

	tokenType := token.TokenType
	if tokenType == "" {
		tokenType = "Bearer"
	}
	// Capitalize first letter of token type (e.g. "bearer" -> "Bearer").
	if len(tokenType) > 0 {
		tokenType = strings.ToUpper(tokenType[:1]) + tokenType[1:]
	}
	utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "resolved oauth authorization header", map[string]any{
		"serverName": serverName, "tokenType": tokenType,
		"expiresAt": token.ExpiresAt.Format(time.RFC3339),
	})
	return map[string]string{
		"Authorization": tokenType + " " + token.AccessToken,
	}
}
