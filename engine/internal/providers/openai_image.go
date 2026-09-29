package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const imageGenerationTimeout = 90 * time.Second

type openaiImageProvider struct {
	id      string
	baseURL string
	client  *http.Client
}

// NewOpenAIImageProvider creates an ImageProvider for OpenAI image-generation
// APIs (DALL-E 3, gpt-image-1) and OpenAI-compatible image endpoints behind
// enterprise gateways. Holds no credential (R-23): authentication is
// resolved per request from the context via applyRequestAuth, same as the
// chat provider (NewOpenAIProvider).
func NewOpenAIImageProvider(opts *ProviderOptions) ImageProvider {
	baseURL := "https://api.openai.com"
	id := "openai"
	if opts != nil {
		if opts.BaseURL != "" {
			baseURL = opts.BaseURL
		}
		if opts.ID != "" {
			id = opts.ID
		}
	}
	p := &openaiImageProvider{
		id:      id,
		baseURL: baseURL,
		client:  &http.Client{Transport: network.GetHTTPTransport()},
	}
	utils.LogWithFields(utils.LevelInfo, "OpenAIImage", "new image provider", map[string]any{"provider": id, "path": baseURL})
	return p
}

func (p *openaiImageProvider) ID() string { return p.id }

// Generate submits opts.Prompt to the OpenAI images/generations endpoint and
// returns each result as a base64-encoded ImageResult. The provider always
// requests response_format=b64_json so no secondary download is needed.
func (p *openaiImageProvider) Generate(ctx context.Context, opts types.ImageGenerateOptions) ([]types.ImageResult, error) {
	// Strip a provider-qualified id ("<provider>/<model>") to the bare wire
	// model — gateways and upstream APIs expect the vendor's model id.
	opts.Model = StripProviderQualifier(p.id, opts.Model)
	utils.LogWithFields(utils.LevelInfo, "OpenAIImage", "generate start", map[string]any{
		"model":  opts.Model,
		"size":   opts.Size,
		"prompt": truncate(opts.Prompt, 80),
	})

	n := opts.N
	if n <= 0 {
		n = 1
	}
	size := opts.Size
	if size == "" {
		size = "1024x1024"
	}

	reqBody := map[string]any{
		"model":           opts.Model,
		"prompt":          opts.Prompt,
		"n":               n,
		"response_format": "b64_json",
		"size":            size,
	}
	if opts.Quality != "" {
		reqBody["quality"] = opts.Quality
	}
	if opts.Style != "" {
		reqBody["style"] = opts.Style
	}

	raw, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("openai image: marshal request: %w", err)
	}

	endpoint := buildImageEndpoint(p.baseURL)
	utils.LogWithFields(utils.LevelInfo, "OpenAIImage", "generate endpoint resolved", map[string]any{"path": endpoint})

	reqCtx, cancel := context.WithTimeout(ctx, imageGenerationTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("openai image: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if pe := applyRequestAuth(ctx, req, raw, p.id); pe != nil {
		return nil, fmt.Errorf("openai image: %s", pe.Message)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai image: http: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "OpenAIImage", "response body close error", map[string]any{"error": closeErr.Error()})
		}
	}()

	utils.LogWithFields(utils.LevelDebug, "OpenAIImage", "generate http response", map[string]any{"status": resp.StatusCode})

	if resp.StatusCode != http.StatusOK {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2048))
		if readErr != nil {
			utils.LogWithFields(utils.LevelWarn, "OpenAIImage", "failed to read error body", map[string]any{"error": readErr.Error()})
		}
		utils.LogWithFields(utils.LevelError, "OpenAIImage", "generate http error", map[string]any{
			"status": resp.StatusCode,
			"body":   string(body),
		})
		return nil, fmt.Errorf("openai image: API error %d: %s", resp.StatusCode, string(body))
	}

	// Read the full body so we can log it on parse failure or empty result.
	// The response is a small JSON payload (never streaming), so reading it
	// all at once is safe and gives us the raw shape for diagnostics.
	rawBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, fmt.Errorf("openai image: read response body: %w", readErr)
	}
	utils.LogWithFields(utils.LevelDebug, "OpenAIImage", "generate raw response", map[string]any{
		"model": opts.Model,
		"len":   len(rawBody),
		"body":  truncate(string(rawBody), 512),
	})

	var parsed struct {
		Data []struct {
			B64JSON       string `json:"b64_json"`
			RevisedPrompt string `json:"revised_prompt"`
			// URL is returned by some endpoints when response_format is "url"
			// (not what we request, but log it if present so we can diagnose
			// gateways that ignore response_format and return URLs anyway).
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		utils.LogWithFields(utils.LevelError, "OpenAIImage", "generate decode failed", map[string]any{
			"model": opts.Model,
			"error": err.Error(),
			"body":  truncate(string(rawBody), 512),
		})
		return nil, fmt.Errorf("openai image: decode response: %w", err)
	}

	results := make([]types.ImageResult, 0, len(parsed.Data))
	for i, d := range parsed.Data {
		if d.B64JSON == "" {
			// Log each skipped entry so we can see what the gateway returned
			// instead of b64_json (e.g. a URL, or an empty object).
			utils.LogWithFields(utils.LevelWarn, "OpenAIImage", "generate result missing b64_json; skipping", map[string]any{
				"model": opts.Model,
				"index": i,
				"url":   d.URL,
			})
			continue
		}
		results = append(results, types.ImageResult{
			Data:          d.B64JSON,
			MediaType:     "image/png",
			RevisedPrompt: d.RevisedPrompt,
		})
	}
	utils.LogWithFields(utils.LevelInfo, "OpenAIImage", "generate complete", map[string]any{
		"model": opts.Model,
		"count": len(results),
	})
	return results, nil
}

// buildImageEndpoint constructs the images/generations URL from a base URL,
// handling the same /v1 suffix logic as the chat provider.
func buildImageEndpoint(baseURL string) string {
	if strings.HasSuffix(baseURL, "/v1") || strings.Contains(baseURL, "/v1/") {
		return strings.TrimRight(baseURL, "/") + "/images/generations"
	}
	return baseURL + "/v1/images/generations"
}

// truncate returns at most n runes of s, appending "…" when truncated.
func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}
