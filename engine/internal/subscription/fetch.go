// Package subscription resolves a provider's subscription key from a lookup
// endpoint using the signed-in identity (Provider Subscription). The request
// and response are the published v1 contract in
// docs/configuration/subscription-lookup.md.
package subscription

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

// ContractVersion is the request/response contract version the engine
// speaks. It travels on every request in VersionHeader so a service can
// answer each version it supports.
const ContractVersion = "1"

// VersionHeader carries ContractVersion on the lookup request.
const VersionHeader = "Ion-Subscription-Lookup-Version"

// maxResponseBytes caps the lookup response the engine will read.
const maxResponseBytes = int64(1024 * 1024)

// Subscription is one entry of a lookup response. Key is the secret; it is
// applied to the resolver and cached encrypted, never reported.
type Subscription struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Key   string `json:"key"`
}

// Option is the subscription without its key.
func (s Subscription) Option() types.SubscriptionOption {
	return types.SubscriptionOption{ID: s.ID, Label: s.Label}
}

// Fetcher performs one lookup. HTTPFetcher is the engine's implementation;
// the type is the seam tests and other transports use.
type Fetcher func(ctx context.Context, cfg types.SubscriptionLookupConfig) ([]Subscription, error)

// HTTPFetcher GETs the endpoint with the signed-in identity's bearer token
// and decodes the v1 response. The token is minted by the engine's own token
// provider, so no consumer ever handles it.
func HTTPFetcher(ctx context.Context, cfg types.SubscriptionLookupConfig) ([]Subscription, error) {
	if err := ValidateEndpoint(cfg.Endpoint); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set(VersionHeader, ContractVersion)
	authenticator := auth.BearerAuthenticator{Provider: auth.CurrentTokenProvider(), Scope: cfg.Scope, Audience: cfg.Audience}
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
			utils.LogWithFields(utils.LevelInfo, "subscription", "response body close failed", map[string]any{"error": closeErr.Error()})
		}
	}()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	utils.LogWithFields(utils.LevelInfo, "subscription", "subscription lookup endpoint answered", map[string]any{
		"url": cfg.Endpoint, "status": resp.StatusCode, "count": len(body),
	})
	if int64(len(body)) > maxResponseBytes {
		return nil, fmt.Errorf("response too large: exceeded %d bytes", maxResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("endpoint returned status %d", resp.StatusCode)
	}
	return DecodeResponse(body)
}

// ValidateEndpoint accepts an absolute http or https URL.
func ValidateEndpoint(endpoint string) error {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("invalid endpoint %q: %w", endpoint, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("endpoint must be http or https, got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return fmt.Errorf("endpoint %q has no host", endpoint)
	}
	return nil
}

// DecodeResponse parses a v1 response: a JSON array of subscriptions. Fields
// beyond id, label, and key are ignored so a service can add optional fields
// without breaking the engine. Every entry needs all three, and ids are
// unique, because selection is remembered by id.
func DecodeResponse(body []byte) ([]Subscription, error) {
	var entries []Subscription
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("response is not a subscription array: %w", err)
	}
	if entries == nil {
		return nil, fmt.Errorf("response is not a subscription array: got null")
	}
	seen := make(map[string]bool, len(entries))
	for i, entry := range entries {
		switch {
		case entry.ID == "":
			return nil, fmt.Errorf("subscription %d has no id", i)
		case entry.Label == "":
			return nil, fmt.Errorf("subscription %q has no label", entry.ID)
		case entry.Key == "":
			return nil, fmt.Errorf("subscription %q has no key", entry.ID)
		case seen[entry.ID]:
			return nil, fmt.Errorf("subscription id %q appears more than once", entry.ID)
		}
		seen[entry.ID] = true
	}
	return entries, nil
}
