package appconfig

import (
	"bytes"
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

// Validators are the change-detection values the source returned with the
// last resolved document. A refresh sends them back so an unchanged source
// answers 304 instead of the whole document.
type Validators struct {
	ETag         string
	LastModified string
}

// FetchResult is one resolution. NotModified means the source confirmed the
// previous document is current; Document is nil then.
type FetchResult struct {
	Document    *Document
	Validators  Validators
	NotModified bool
}

// HTTPFetcher GETs the source endpoint with the process identity's bearer
// token and decodes the body as a Document. The token is minted by the
// engine's own token provider, the same one every engine-authenticated
// request uses, so no extension ever handles it. prior carries the
// validators of the last document for a conditional request.
func HTTPFetcher(ctx context.Context, source types.ApplicationConfigSource, prior Validators) (FetchResult, error) {
	parsed, err := url.Parse(source.Endpoint)
	if err != nil {
		return FetchResult{}, fmt.Errorf("invalid endpoint %q: %w", source.Endpoint, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return FetchResult{}, fmt.Errorf("endpoint must be http or https, got %q", parsed.Scheme)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source.Endpoint, nil)
	if err != nil {
		return FetchResult{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if prior.ETag != "" {
		req.Header.Set("If-None-Match", prior.ETag)
	}
	if prior.LastModified != "" {
		req.Header.Set("If-Modified-Since", prior.LastModified)
	}
	authenticator := auth.BearerAuthenticator{Provider: auth.CurrentTokenProvider(), Scope: source.Scope, Audience: source.Audience}
	if err := authenticator.Authenticate(ctx, req, nil); err != nil {
		return FetchResult{}, fmt.Errorf("authenticate request: %w", err)
	}
	client := &http.Client{Transport: network.GetHTTPTransport().Clone()}
	resp, err := client.Do(req)
	if err != nil {
		return FetchResult{}, fmt.Errorf("request failed: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "appconfig", "response body close failed", map[string]any{"error": closeErr.Error()})
		}
	}()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return FetchResult{}, fmt.Errorf("read response: %w", err)
	}
	if int64(len(body)) > maxResponseBytes {
		return FetchResult{}, fmt.Errorf("response too large: exceeded %d bytes", maxResponseBytes)
	}
	conditional := prior.ETag != "" || prior.LastModified != ""
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config endpoint answered", map[string]any{
		"url": source.Endpoint, "status": resp.StatusCode, "count": len(body), "conditional": conditional,
	})
	if resp.StatusCode == http.StatusNotModified && conditional {
		return FetchResult{NotModified: true, Validators: prior}, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return FetchResult{}, fmt.Errorf("endpoint returned status %d", resp.StatusCode)
	}
	document, err := DecodeDocument(body)
	if err != nil {
		return FetchResult{}, err
	}
	return FetchResult{
		Document:   document,
		Validators: Validators{ETag: resp.Header.Get("ETag"), LastModified: resp.Header.Get("Last-Modified")},
	}, nil
}

// DecodeDocument parses a source response. Unknown top-level fields are
// rejected so a source still serving another shape fails loudly instead of
// resolving to an empty configuration. A key may be a value or a secret
// within one section, never both.
func DecodeDocument(body []byte) (*Document, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var document *Document
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("response is not an application config document: %w", err)
	}
	if document == nil {
		return nil, fmt.Errorf("response is not an application config document: got null")
	}
	if err := checkSection("common", document.Common); err != nil {
		return nil, err
	}
	for id, section := range document.Extensions {
		if id == "" {
			return nil, fmt.Errorf("response names an extension section with an empty id")
		}
		if err := checkSection("extensions."+id, section); err != nil {
			return nil, err
		}
	}
	return document, nil
}

func checkSection(name string, section Section) error {
	for key := range section.Secrets {
		if _, ok := section.Values[key]; ok {
			return fmt.Errorf("section %s declares %q as both a value and a secret", name, key)
		}
	}
	return nil
}
