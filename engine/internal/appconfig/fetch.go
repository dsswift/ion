package appconfig

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// maxResponseBytes caps the configuration document the engine will read.
const maxResponseBytes = int64(5 * 1024 * 1024)

// HTTPFetcher GETs the source endpoint with the process identity's bearer
// token and decodes the body as a JSON object. The token is minted by the
// engine's own token provider, the same one every engine-authenticated
// request uses, so no extension ever handles it.
func HTTPFetcher(ctx context.Context, source types.ApplicationConfigSource) (map[string]any, error) {
	parsed, err := url.Parse(source.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("invalid endpoint %q: %w", source.Endpoint, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("endpoint must be http or https, got %q", parsed.Scheme)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.Endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	authenticator := auth.BearerAuthenticator{Provider: auth.CurrentTokenProvider(), Scope: source.Scope, Audience: source.Audience}
	if err := authenticator.Authenticate(ctx, req, nil); err != nil {
		return nil, fmt.Errorf("authenticate request: %w", err)
	}
	client := &http.Client{Transport: network.GetHTTPTransport().Clone()}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "appconfig", "response body close failed", map[string]any{"error": closeErr.Error()})
		}
	}()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if int64(len(body)) > maxResponseBytes {
		return nil, fmt.Errorf("response too large: exceeded %d bytes", maxResponseBytes)
	}
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config endpoint answered", map[string]any{
		"url": source.Endpoint, "status": resp.StatusCode, "count": len(body),
	})
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("endpoint returned status %d", resp.StatusCode)
	}
	var values map[string]any
	if err := json.Unmarshal(body, &values); err != nil {
		return nil, fmt.Errorf("response is not a JSON object: %w", err)
	}
	if values == nil {
		return nil, fmt.Errorf("response is not a JSON object: got null")
	}
	return values, nil
}
