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
)

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
func InitiateDeviceFlow(clientID, tokenURL string) (*DeviceFlowResult, error) {
	// Device flow uses the authorization endpoint, typically at
	// tokenURL minus "/token" plus "/device/code" or similar.
	// We accept the full device authorization URL as tokenURL here.
	form := url.Values{
		"client_id": {clientID},
		"scope":     {"openid"},
	}

	resp, err := http.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("device flow request failed: %w", err)
	}
	defer resp.Body.Close()

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
// for an access token. This is a single poll attempt; the caller should
// loop with the interval from DeviceFlowResult.
func ExchangeDeviceCode(clientID, deviceCode, tokenURL string) (string, error) {
	form := url.Values{
		"client_id":   {clientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(tokenURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("token exchange request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("token exchange read error: %w", err)
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("token exchange parse error: %w", err)
	}

	if tokenResp.Error != "" {
		return "", fmt.Errorf("token exchange error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("no access token in response")
	}

	return tokenResp.AccessToken, nil
}

// --- PKCE Authorization Code Flow ---

// PKCEFlowConfig holds OAuth PKCE configuration.
type PKCEFlowConfig struct {
	ClientID     string
	AuthURL      string // authorization endpoint
	TokenURL     string // token exchange endpoint
	Scope        string
	RedirectPort int // 0 = auto-assign
}

// PKCEFlowResult contains the started flow's URL and completion channel.
type PKCEFlowResult struct {
	AuthorizationURL string
	Token            <-chan string
	Err              <-chan error
	Cancel           func()
}

// StartPKCEFlow initiates OAuth 2.0 Authorization Code + PKCE flow.
// It starts a local HTTP server on 127.0.0.1 to receive the authorization
// callback, then returns the authorization URL for the caller to open in
// a browser. The Token channel receives the access token on success; the
// Err channel receives any error. The entire flow times out after 5 minutes.
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

	// Start local callback server.
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.RedirectPort)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("pkce: listen on %s: %w", addr, err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	// Build authorization URL.
	authURL, err := buildAuthorizationURL(cfg, redirectURI, challenge, state)
	if err != nil {
		listener.Close()
		return nil, fmt.Errorf("pkce: build auth url: %w", err)
	}

	tokenCh := make(chan string, 1)
	errCh := make(chan error, 1)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)

	mux := http.NewServeMux()
	server := &http.Server{Handler: mux}

	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		if errParam := q.Get("error"); errParam != "" {
			desc := q.Get("error_description")
			errCh <- fmt.Errorf("authorization error: %s: %s", errParam, desc)
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, "<html><body><p>Authorization failed. You can close this tab.</p></body></html>")
			go server.Shutdown(context.Background())
			return
		}

		if q.Get("state") != state {
			errCh <- fmt.Errorf("state mismatch")
			http.Error(w, "state mismatch", http.StatusBadRequest)
			go server.Shutdown(context.Background())
			return
		}

		code := q.Get("code")
		if code == "" {
			errCh <- fmt.Errorf("no authorization code in callback")
			http.Error(w, "missing code", http.StatusBadRequest)
			go server.Shutdown(context.Background())
			return
		}

		token, exchangeErr := exchangeCodeForToken(cfg, code, verifier, redirectURI)
		if exchangeErr != nil {
			errCh <- exchangeErr
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, "<html><body><p>Token exchange failed. You can close this tab.</p></body></html>")
			go server.Shutdown(context.Background())
			return
		}

		tokenCh <- token
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, "<html><body><p>Authorization complete. You can close this tab.</p></body></html>")
		go server.Shutdown(context.Background())
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
		server.Shutdown(context.Background())
	}()

	return &PKCEFlowResult{
		AuthorizationURL: authURL,
		Token:            tokenCh,
		Err:              errCh,
		Cancel: func() {
			cancel()
			server.Shutdown(context.Background())
		},
	}, nil
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
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// exchangeCodeForToken exchanges an authorization code for an access token.
func exchangeCodeForToken(cfg PKCEFlowConfig, code, verifier, redirectURI string) (string, error) {
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
		return "", fmt.Errorf("pkce token exchange request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("pkce token exchange read error: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("pkce token exchange failed (status %d): %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("pkce token exchange parse error: %w", err)
	}

	if tokenResp.Error != "" {
		return "", fmt.Errorf("pkce token exchange error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("pkce: no access token in response")
	}

	return tokenResp.AccessToken, nil
}
