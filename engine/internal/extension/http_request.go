// http_request.go — pre-authenticated outbound HTTP for extensions.
//
// DoOperatorHTTPRequest is the single implementation behind both SDK
// surfaces: the Go Context.HTTPRequest field (third-party Go harnesses) and
// the ext/http_request JSON-RPC method (the TypeScript SDK's ctx.http.*).
//
// The engine performs the request and injects the signed-in operator's
// bearer token for the scope the extension declares. The raw token never
// crosses into extension code: the request params carry no token, and the
// response carries only status/headers/body. This is the safe-wrapper
// contract — extensions get "make this call as the operator," not "hand me
// the operator's credential."
package extension

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/utils"
)

// operatorHTTPDefaultTimeout bounds a request when the extension supplies
// no timeout. Matches WebFetch's default.
const operatorHTTPDefaultTimeout = 30 * time.Second

// operatorHTTPDefaultMaxBytes caps the response body when the extension
// supplies no limit. Matches WebFetch's default.
const operatorHTTPDefaultMaxBytes = int64(5 * 1024 * 1024)

// OperatorHTTPRequestParams describes an extension's outbound request.
type OperatorHTTPRequestParams struct {
	// Scope names the downstream resource the minted token must carry
	// (e.g. "api://<app-id>/Billing.Read"). Empty requests a token with
	// the base grant's scope.
	Scope string `json:"scope,omitempty"`
	// Audience is the explicit audience/resource for the minted token, for
	// IdPs that bind grants to one (Auth0, RFC 8707) instead of encoding
	// the resource in the scope string. Empty uses the provider's
	// configured default audience.
	Audience string `json:"audience,omitempty"`
	// Method is the HTTP method; defaults to GET.
	Method string `json:"method,omitempty"`
	// URL is the absolute http(s) target.
	URL string `json:"url"`
	// Headers are extension-supplied request headers. Authorization is
	// reserved: the engine overwrites it with the minted operator token.
	Headers map[string]string `json:"headers,omitempty"`
	// Body is the request body (sent for methods that carry one).
	Body string `json:"body,omitempty"`
	// TimeoutMs bounds the request; <= 0 selects the 30 s default.
	TimeoutMs float64 `json:"timeoutMs,omitempty"`
	// MaxBytes caps the response body; <= 0 selects the 5 MB default.
	MaxBytes int64 `json:"maxBytes,omitempty"`
	// AllowPrivateNetwork opts this request out of the private/reserved
	// address guard. WebFetch offers no such escape because the LLM drives
	// it; here the caller is operator-installed extension code declaring
	// intent to reach an intranet API (the enterprise downstream case), so
	// the opt-out is a legitimate, explicit seam. Default false (guarded).
	AllowPrivateNetwork bool `json:"allowPrivateNetwork,omitempty"`
}

// OperatorHTTPResponse is what the extension receives. It intentionally
// has no token-bearing field.
type OperatorHTTPResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body"`
}

// DoOperatorHTTPRequest validates the request, mints the operator token for
// the declared scope, performs the call, and returns the bounded response.
func DoOperatorHTTPRequest(ctx context.Context, params OperatorHTTPRequestParams) (*OperatorHTTPResponse, error) {
	op := auth.Operator()
	if op == nil {
		return nil, fmt.Errorf("no operator identity configured (set auth.identityProvider in engine.json)")
	}

	if params.URL == "" {
		return nil, fmt.Errorf("url is required")
	}
	parsed, err := url.Parse(params.URL)
	if err != nil {
		return nil, fmt.Errorf("invalid url %q: %w", params.URL, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("blocked: only http/https protocols allowed, got %q", parsed.Scheme)
	}
	if !params.AllowPrivateNetwork && tools.IsBlockedHost(parsed.Hostname()) {
		return nil, fmt.Errorf("blocked: private/reserved address %q (set allowPrivateNetwork to reach intranet APIs)", parsed.Hostname())
	}

	method := strings.ToUpper(params.Method)
	if method == "" {
		method = http.MethodGet
	}

	timeout := operatorHTTPDefaultTimeout
	if params.TimeoutMs > 0 {
		timeout = time.Duration(params.TimeoutMs) * time.Millisecond
	}
	maxBytes := operatorHTTPDefaultMaxBytes
	if params.MaxBytes > 0 {
		maxBytes = params.MaxBytes
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var bodyReader io.Reader
	if params.Body != "" {
		bodyReader = strings.NewReader(params.Body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, params.URL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	for k, v := range params.Headers {
		req.Header.Set(k, v)
	}

	// Mint the token for the declared scope and inject it. This always
	// overwrites any extension-supplied Authorization header: carrying
	// credentials is the wrapper's job, never the extension's.
	token, err := op.GetTokenWithAudience(reqCtx, params.Scope, params.Audience)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension.http", "operator token mint failed", map[string]any{
			"scope":    params.Scope,
			"audience": params.Audience,
			"url":      params.URL,
			"error":    err.Error(),
		})
		return nil, fmt.Errorf("operator token for scope %q: %w", params.Scope, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	utils.LogWithFields(utils.LevelInfo, "extension.http", "operator http request", map[string]any{
		"method": method,
		"url":    params.URL,
		"scope":  params.Scope,
	})

	resp, err := network.GetHTTPClient().Do(req)
	if err != nil {
		if reqCtx.Err() != nil {
			return nil, fmt.Errorf("request timed out after %s", timeout)
		}
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.http", "response body close failed", map[string]any{"error": closeErr.Error()})
		}
	}()

	limited := io.LimitReader(resp.Body, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("response too large: exceeded %d bytes", maxBytes)
	}

	headers := make(map[string]string, len(resp.Header))
	for k := range resp.Header {
		headers[k] = resp.Header.Get(k)
	}

	utils.LogWithFields(utils.LevelInfo, "extension.http", "operator http response", map[string]any{
		"method": method,
		"url":    params.URL,
		"status": resp.StatusCode,
		"count":  len(data),
	})

	return &OperatorHTTPResponse{
		Status:  resp.StatusCode,
		Headers: headers,
		Body:    string(data),
	}, nil
}
