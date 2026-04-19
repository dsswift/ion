package mcp

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

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
	home, _ := os.UserHomeDir()
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

	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {existing.RefreshToken},
		"client_id":     {config.ClientID},
	}
	if config.ClientSecret != "" {
		form.Set("client_secret", config.ClientSecret)
	}

	resp, err := http.PostForm(config.TokenURL, form)
	if err != nil {
		return nil, fmt.Errorf("refresh token request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("refresh token failed with status %d", resp.StatusCode)
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

// GeneratePKCEChallenge creates a PKCE code_verifier and SHA256 code_challenge.
func GeneratePKCEChallenge() (verifier string, challenge string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("generate PKCE verifier: %w", err)
	}
	verifier = base64.RawURLEncoding.EncodeToString(buf)

	hash := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(hash[:])

	return verifier, challenge, nil
}

func (s *OAuthStore) save() {
	data, err := json.MarshalIndent(s.tokens, "", "  ")
	if err != nil {
		return
	}
	dir := filepath.Dir(s.path)
	os.MkdirAll(dir, 0700)
	os.WriteFile(s.path, data, 0600)
}

func (s *OAuthStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var tokens map[string]*OAuthToken
	if err := json.Unmarshal(data, &tokens); err != nil {
		return
	}
	s.tokens = tokens
}

// resolveOAuthHeaders returns auth headers for a server, refreshing if needed.
func resolveOAuthHeaders(serverName string, oauthConfig *OAuthConfig) map[string]string {
	if oauthConfig == nil {
		return nil
	}

	store := NewOAuthStore()
	token := store.GetToken(serverName)

	// Try refresh if token is expired but refresh token exists.
	if token == nil {
		var err error
		token, err = store.RefreshToken(serverName, oauthConfig)
		if err != nil {
			return nil
		}
	}

	if token == nil {
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
	return map[string]string{
		"Authorization": tokenType + " " + token.AccessToken,
	}
}
