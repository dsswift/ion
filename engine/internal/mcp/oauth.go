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
	// Issuer is the authorization server that minted this token. Used for
	// credential binding: a token minted by issuer A is not sent to a
	// server whose metadata now points at issuer B.
	Issuer string `json:"issuer,omitempty"`
	// Resource is the RFC 8707 resource indicator the token was obtained
	// for. Used for credential binding alongside Issuer.
	Resource string `json:"resource,omitempty"`
}

// OAuthConfig holds the OAuth 2.0 configuration for an MCP server.
type OAuthConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	AuthURL      string `json:"auth_url"`
	TokenURL     string `json:"token_url"`
	Scope        string `json:"scope,omitempty"`
	RedirectURI  string `json:"redirect_uri,omitempty"`
	// Resource is the RFC 8707 resource indicator for this server.
	Resource string `json:"resource,omitempty"`
}

// OAuthStore manages per-server OAuth tokens with file persistence.
type OAuthStore struct {
	mu     sync.RWMutex
	tokens map[string]*OAuthToken
	path   string
}

// NewOAuthStore creates a token store backed by ~/.ion/mcp-tokens.json.
func NewOAuthStore() *OAuthStore {
	storePath := filepath.Join(utils.IonDir(), "mcp-tokens.json")

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
	if config.Resource != "" {
		form.Set("resource", config.Resource)
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

		// Classify before returning. A spent or revoked grant is not the same
		// failure as a 500, and reporting both as "refresh token failed with
		// status N" sends the operator to retry a thing that will never work.
		grantErr := classifyGrantFailure(serverName, resp.StatusCode, body)
		fields := map[string]any{
			"serverName": serverName, "status": resp.StatusCode, "tokenUrl": config.TokenURL,
			"oauthErrorCode": grantErr.Code, "unrecoverable": grantErr.Unrecoverable,
			"body": string(body),
		}
		if grantErr.Unrecoverable {
			// The operator has to act, and this log line is the only place a
			// headless engine can tell them so.
			fields["remediation"] = "run `ion mcp login " + serverName + "` to re-authorize"
			utils.LogWithFields(utils.LevelError, "mcp.oauth", "stored authorization can no longer be renewed; interactive re-login required", fields)
		} else {
			utils.LogWithFields(utils.LevelError, "mcp.oauth", "refresh token rejected by provider; may succeed on retry", fields)
		}
		recordGrantFailure(serverName, grantErr)
		return nil, grantErr
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
		Issuer:      existing.Issuer,
		Resource:    existing.Resource,
	}
	if tokenResp.RefreshToken != "" {
		token.RefreshToken = tokenResp.RefreshToken
	} else {
		token.RefreshToken = existing.RefreshToken
	}

	s.SetToken(serverName, token)
	// The grant works: forget any recorded death so a stale reason cannot
	// outlive the problem it described.
	clearGrantFailure(serverName)
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
	if err := utils.AtomicWriteFile(s.path, data, 0o600); err != nil {
		utils.LogWithFields(utils.LevelInfo, "mcp.oauth", "save write failed", map[string]any{"path": s.path, "error": err.Error()})
		return
	}
	// On Windows the 0o600 above is not a permission -- see RestrictToOwner.
	// This store holds OAuth access/refresh tokens, so a failure to narrow
	// the ACL is worth logging even though save() has no error return to
	// escalate it through.
	if err := utils.RestrictToOwner(s.path); err != nil {
		utils.LogWithFields(utils.LevelError, "mcp.oauth", "restrict to owner failed", map[string]any{"path": s.path, "error": err.Error()})
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

// getOAuthStore returns the package-level OAuthStore for the current home.
//
// The engine normally runs with one stable HOME. Tests and embedded consumers
// can change HOME, though, so the singleton must not keep serving credentials
// loaded from an earlier home directory. The path check preserves the shared
// store within one home while replacing it when the storage root changes.
var (
	globalOAuthStore   *OAuthStore
	globalOAuthStoreMu sync.Mutex
)

func getOAuthStore() *OAuthStore {
	path := filepath.Join(utils.IonDir(), "mcp-tokens.json")

	globalOAuthStoreMu.Lock()
	defer globalOAuthStoreMu.Unlock()
	if globalOAuthStore == nil || globalOAuthStore.path != path {
		globalOAuthStore = NewOAuthStore()
	}
	return globalOAuthStore
}
