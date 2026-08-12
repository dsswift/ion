package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	azureIMDSEndpoint   = "http://169.254.169.254/metadata/identity/oauth2/token"
	azureIMDSAPIVer     = "2018-02-01"
	azureEndpointAPIVer = "2019-08-01"
	azureMaxRetries     = 3
	azureRetryBackoff   = 500 * time.Millisecond
)

type AzureMachineIdentityConfig struct{ ClientID string }

var lookupEnv = os.LookupEnv

type azureTokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresOn   string `json:"expires_on"`
	ExpiresIn   string `json:"expires_in"`
	Resource    string `json:"resource"`
	TokenType   string `json:"token_type"`
}

type azureErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type AzureIdentitySource struct {
	cfg          AzureMachineIdentityConfig
	imdsEndpoint string
	client       *http.Client
}

type AzureIdentityOption func(*AzureIdentitySource)

func WithAzureEndpoint(endpoint string) AzureIdentityOption {
	return func(s *AzureIdentitySource) { s.imdsEndpoint = endpoint }
}
func WithAzureHTTPClient(client *http.Client) AzureIdentityOption {
	return func(s *AzureIdentitySource) { s.client = client }
}

func NewAzureIdentitySource(cfg AzureMachineIdentityConfig, opts ...AzureIdentityOption) *AzureIdentitySource {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
		ResponseHeaderTimeout: 3 * time.Second,
	}
	source := &AzureIdentitySource{
		cfg: cfg, imdsEndpoint: azureIMDSEndpoint,
		client: &http.Client{Transport: transport, Timeout: 4 * time.Second},
	}
	for _, option := range opts {
		option(source)
	}
	return source
}

// Acquire selects the Container Apps/App Service identity endpoint whenever
// IDENTITY_ENDPOINT is present; VMs and VMSS use IMDS. audience is Azure's
// resource. A scope ending in /.default converts exactly when audience is empty.
func (s *AzureIdentitySource) Acquire(ctx context.Context, scope, audience string) (string, time.Time, error) {
	resource, err := azureResource(scope, audience)
	if err != nil {
		return "", time.Time{}, err
	}
	endpoint, headerName, headerValue, apiVersion, transportKind, err := s.transportConfig()
	if err != nil {
		return "", time.Time{}, err
	}
	reqURL, err := s.buildURL(endpoint, apiVersion, resource)
	if err != nil {
		return "", time.Time{}, err
	}
	endpointLog := endpoint
	if parsed, parseErr := url.Parse(endpoint); parseErr == nil {
		endpointLog = parsed.Scheme + "://" + parsed.Host + parsed.Path
	}
	utils.LogWithFields(utils.LevelDebug, "auth.azure", "managed identity acquisition started", map[string]any{
		"transport": transportKind, "resource": resource, "has_client_id": s.cfg.ClientID != "", "endpoint": endpointLog,
	})

	var lastErr error
	for attempt := 0; attempt <= azureMaxRetries; attempt++ {
		if attempt > 0 {
			delay := azureRetryBackoff * time.Duration(1<<(attempt-1))
			var responseErr *httpError
			if errors.As(lastErr, &responseErr) && responseErr.retryAfter > delay {
				delay = responseErr.retryAfter
			}
			select {
			case <-ctx.Done():
				return "", time.Time{}, ctx.Err()
			case <-time.After(delay):
			}
		}
		token, expiry, requestErr := s.doRequest(ctx, reqURL, headerName, headerValue)
		if requestErr == nil {
			utils.LogWithFields(utils.LevelInfo, "auth.azure", "managed identity token acquired", map[string]any{
				"transport": transportKind, "resource": resource, "expires_at": expiry, "attempt": attempt + 1,
			})
			return token, expiry, nil
		}
		lastErr = requestErr
		if !isRetryableHTTPError(requestErr) {
			utils.LogWithFields(utils.LevelError, "auth.azure", "managed identity acquisition failed", map[string]any{
				"transport": transportKind, "resource": resource, "error": redactError(requestErr), "attempt": attempt + 1,
			})
			return "", time.Time{}, fmt.Errorf("azure managed identity: %w", requestErr)
		}
		utils.LogWithFields(utils.LevelWarn, "auth.azure", "managed identity request retrying", map[string]any{
			"transport": transportKind, "resource": resource, "error": redactError(requestErr), "attempt": attempt + 1,
		})
	}
	return "", time.Time{}, fmt.Errorf("azure managed identity retries exhausted: %w", lastErr)
}

func azureResource(scope, audience string) (string, error) {
	if audience != "" {
		return audience, nil
	}
	if strings.HasSuffix(scope, "/.default") {
		return strings.TrimSuffix(scope, "/.default"), nil
	}
	return "", fmt.Errorf("azure managed identity requires resource/audience; scope-only requests must end in /.default")
}

func (s *AzureIdentitySource) transportConfig() (endpoint, headerName, headerValue, apiVersion, kind string, err error) {
	if endpoint, present := lookupEnv("IDENTITY_ENDPOINT"); present {
		if endpoint == "" {
			return "", "", "", "", "", fmt.Errorf("IDENTITY_ENDPOINT is present but empty")
		}
		headerValue, headerPresent := lookupEnv("IDENTITY_HEADER")
		if !headerPresent || headerValue == "" {
			return "", "", "", "", "", fmt.Errorf("IDENTITY_ENDPOINT is set but IDENTITY_HEADER is empty")
		}
		return endpoint, "X-IDENTITY-HEADER", headerValue, azureEndpointAPIVer, "identity_endpoint", nil
	}
	return s.imdsEndpoint, "Metadata", "true", azureIMDSAPIVer, "imds", nil
}

func (s *AzureIdentitySource) buildURL(endpoint, apiVersion, resource string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("azure managed identity endpoint is invalid")
	}
	q := u.Query()
	q.Set("api-version", apiVersion)
	q.Set("resource", resource)
	if s.cfg.ClientID != "" {
		q.Set("client_id", s.cfg.ClientID)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (s *AzureIdentitySource) doRequest(ctx context.Context, reqURL, headerName, headerValue string) (string, time.Time, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("build managed identity request: %w", err)
	}
	req.Header.Set(headerName, headerValue)
	resp, err := s.client.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("managed identity request: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "auth.azure", "managed identity response close failed", map[string]any{"error": closeErr.Error()})
		}
	}()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("read managed identity response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		var wireErr azureErrorResponse
		_ = json.Unmarshal(body, &wireErr) //nolint:errcheck // Optional structured detail; status remains authoritative.
		message := wireErr.Error
		if wireErr.ErrorDescription != "" {
			message += ": " + wireErr.ErrorDescription
		}
		if message == "" {
			message = http.StatusText(resp.StatusCode)
		}
		return "", time.Time{}, &httpError{statusCode: resp.StatusCode, message: message, retryAfter: parseRetryAfter(resp.Header.Get("Retry-After"))}
	}
	var token azureTokenResponse
	if err := json.Unmarshal(body, &token); err != nil {
		return "", time.Time{}, fmt.Errorf("parse managed identity response: %w", err)
	}
	if token.AccessToken == "" {
		return "", time.Time{}, fmt.Errorf("managed identity response contains empty access_token")
	}
	expiresAt := parseUnixTimestamp(token.ExpiresOn)
	if expiresAt.IsZero() && token.ExpiresIn != "" {
		seconds, parseErr := strconv.ParseInt(token.ExpiresIn, 10, 64)
		if parseErr == nil && seconds > 0 {
			expiresAt = time.Now().Add(time.Duration(seconds) * time.Second)
		}
	}
	if expiresAt.IsZero() {
		return "", time.Time{}, fmt.Errorf("managed identity response contains invalid expiry")
	}
	return token.AccessToken, expiresAt, nil
}

func parseUnixTimestamp(value string) time.Time {
	seconds, err := strconv.ParseInt(value, 10, 64)
	if err != nil || seconds <= 0 {
		return time.Time{}
	}
	return time.Unix(seconds, 0)
}

func parseRetryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(value)
	if err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}
	return 0
}

type httpError struct {
	statusCode int
	message    string
	retryAfter time.Duration
}

func (e *httpError) Error() string { return fmt.Sprintf("http %d: %s", e.statusCode, e.message) }

func isRetryableHTTPError(err error) bool {
	var responseErr *httpError
	if errors.As(err, &responseErr) {
		return responseErr.statusCode == http.StatusRequestTimeout || responseErr.statusCode == http.StatusTooManyRequests || responseErr.statusCode >= 500
	}
	var networkErr net.Error
	return errors.As(err, &networkErr)
}

func redactError(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	if len(message) > 200 {
		return message[:200] + "...[redacted]"
	}
	return message
}
