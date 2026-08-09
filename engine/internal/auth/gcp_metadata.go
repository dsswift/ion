package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	gcpMetadataEndpoint = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts"
	gcpTimeout          = 4 * time.Second
	gcpMaxRetries       = 3
	gcpRetryBackoff     = 500 * time.Millisecond
)

// GCPMachineIdentityConfig configures the GCP metadata-server token source.
type GCPMachineIdentityConfig struct {
	// ServiceAccount is the service account email. Empty or "default" uses
	// the VM's default service account.
	ServiceAccount string `json:"serviceAccount,omitempty"`
	// TokenType selects the token format: "access_token" (default) returns
	// a standard OAuth2 access token; "id_token" returns a signed OIDC
	// identity token for the given audience.
	TokenType string `json:"tokenType,omitempty"`
}

type gcpTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

// GCPMetadataSource acquires bearer tokens from the GCP instance metadata
// server. It speaks the exact metadata-server protocol: GET with
// Metadata-Flavor: Google header, no proxy, bounded retries.
type GCPMetadataSource struct {
	cfg      GCPMachineIdentityConfig
	endpoint string
	client   *http.Client
}

// GCPMetadataOption configures a test-injectable override.
type GCPMetadataOption func(*GCPMetadataSource)

// WithGCPEndpoint overrides the metadata server endpoint (for testing).
func WithGCPEndpoint(endpoint string) GCPMetadataOption {
	return func(s *GCPMetadataSource) { s.endpoint = endpoint }
}

// WithGCPHTTPClient overrides the HTTP client (for testing).
func WithGCPHTTPClient(c *http.Client) GCPMetadataOption {
	return func(s *GCPMetadataSource) { s.client = c }
}

// NewGCPMetadataSource creates a metadata-server-backed token source. The
// default client forbids proxies (metadata server is link-local) and uses
// a 4s timeout.
func NewGCPMetadataSource(cfg GCPMachineIdentityConfig, opts ...GCPMetadataOption) *GCPMetadataSource {
	s := &GCPMetadataSource{
		cfg:      cfg,
		endpoint: gcpMetadataEndpoint,
		client: &http.Client{
			Timeout: gcpTimeout,
			Transport: &http.Transport{
				Proxy:                 nil,
				DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
				TLSHandshakeTimeout:   2 * time.Second,
				ResponseHeaderTimeout: 3 * time.Second,
			},
		},
	}
	for _, o := range opts {
		o(s)
	}
	return s
}

// Acquire implements TokenSource. For access_token type scope is a
// comma-separated OAuth scope list. For id_token audience identifies the
// target service.
func (s *GCPMetadataSource) Acquire(ctx context.Context, scope, audience string) (string, time.Time, error) {
	resource := scope
	if s.cfg.TokenType == "id_token" {
		resource = audience
	}
	sa := s.cfg.ServiceAccount
	if sa == "" {
		sa = "default"
	}

	tokenType := s.cfg.TokenType
	if tokenType == "" {
		tokenType = "access_token"
	}

	reqURL, err := s.buildURL(sa, tokenType, resource)
	if err != nil {
		return "", time.Time{}, err
	}

	utils.LogWithFields(utils.LevelDebug, "auth.gcp", "acquiring token from metadata server", map[string]any{
		"service_account": sa,
		"token_type":      tokenType,
		"resource":        resource,
	})

	var lastErr error
	for attempt := 0; attempt <= gcpMaxRetries; attempt++ {
		if attempt > 0 {
			backoff := gcpRetryBackoff * time.Duration(1<<(attempt-1))
			select {
			case <-ctx.Done():
				return "", time.Time{}, fmt.Errorf("gcp metadata: %w (after %d attempts, last: %v)", ctx.Err(), attempt, lastErr)
			case <-time.After(backoff):
			}
		}

		token, expiresAt, err := s.doRequest(ctx, reqURL, tokenType)
		if err == nil {
			utils.LogWithFields(utils.LevelInfo, "auth.gcp", "token acquired from metadata server", map[string]any{
				"service_account": sa,
				"token_type":      tokenType,
				"expires_at":      expiresAt,
				"attempt":         attempt + 1,
			})
			return token, expiresAt, nil
		}
		lastErr = err

		if !isRetryableHTTPError(err) {
			utils.LogWithFields(utils.LevelError, "auth.gcp", "non-retryable metadata error", map[string]any{
				"error":   redactError(err),
				"attempt": attempt + 1,
			})
			return "", time.Time{}, fmt.Errorf("gcp metadata: %w", err)
		}

		utils.LogWithFields(utils.LevelDebug, "auth.gcp", "retrying metadata request", map[string]any{
			"error":   redactError(err),
			"attempt": attempt + 1,
		})
	}

	utils.LogWithFields(utils.LevelError, "auth.gcp", "metadata retries exhausted", map[string]any{
		"error": redactError(lastErr),
	})
	return "", time.Time{}, fmt.Errorf("gcp metadata: retries exhausted: %w", lastErr)
}

func (s *GCPMetadataSource) buildURL(sa, tokenType, resource string) (string, error) {
	var rawURL string
	switch tokenType {
	case "id_token":
		rawURL = fmt.Sprintf("%s/%s/identity", s.endpoint, url.PathEscape(sa))
	default:
		rawURL = fmt.Sprintf("%s/%s/token", s.endpoint, url.PathEscape(sa))
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("gcp metadata: parse endpoint: %w", err)
	}

	q := u.Query()
	switch tokenType {
	case "id_token":
		if resource == "" {
			return "", fmt.Errorf("gcp metadata: audience (resource) required for id_token")
		}
		q.Set("audience", resource)
		q.Set("format", "full")
	default:
		if resource != "" {
			q.Set("scopes", resource)
		}
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (s *GCPMetadataSource) doRequest(ctx context.Context, reqURL, tokenType string) (string, time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Metadata-Flavor", "Google")

	resp, err := s.client.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("metadata request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // best-effort close on read-only body

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("read metadata response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, &httpError{
			statusCode: resp.StatusCode,
			message:    fmt.Sprintf("metadata server returned status %d", resp.StatusCode),
		}
	}

	switch tokenType {
	case "id_token":
		token := strings.TrimSpace(string(body))
		if token == "" {
			return "", time.Time{}, fmt.Errorf("metadata server returned empty id_token")
		}
		expiresAt, err := jwtExpiry(token)
		if err != nil {
			return "", time.Time{}, fmt.Errorf("metadata identity token expiry: %w", err)
		}
		return token, expiresAt, nil
	default:
		var tok gcpTokenResponse
		if err := json.Unmarshal(body, &tok); err != nil {
			return "", time.Time{}, fmt.Errorf("parse metadata token response: %w", err)
		}
		if tok.AccessToken == "" {
			return "", time.Time{}, fmt.Errorf("metadata server returned empty access_token")
		}
		var expiresAt time.Time
		if tok.ExpiresIn > 0 {
			expiresAt = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
		}
		return tok.AccessToken, expiresAt, nil
	}
}

func jwtExpiry(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("expected JWT with 3 segments")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("decode JWT payload: %w", err)
	}
	var claims struct {
		Exp json.Number `json:"exp"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil {
		return time.Time{}, fmt.Errorf("parse JWT payload: %w", err)
	}
	seconds, err := strconv.ParseInt(string(claims.Exp), 10, 64)
	if err != nil || seconds <= 0 {
		return time.Time{}, fmt.Errorf("JWT has no valid exp claim")
	}
	return time.Unix(seconds, 0), nil
}
