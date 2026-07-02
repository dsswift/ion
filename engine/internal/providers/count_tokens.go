package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// --- Unsupported-provider stubs ---
//
// The OpenAI family (OpenAI, OpenAI-compatible, Azure, Foundry, Vertex) has no
// native count-tokens endpoint the engine can call cheaply, so these return
// ErrCountUnsupported. Callers fall back to local BPE (tiktoken) or char/4.
//
// Note: Foundry and Vertex are constructed via NewAnthropicProvider, so they
// inherit the Anthropic CountTokens implementation and do NOT appear here.

func (p *openaiProvider) CountTokens(_ context.Context, _ CountTokensRequest) (int, error) {
	return 0, ErrCountUnsupported
}

func (w *compatibleWrapper) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	// OpenAI-compatible endpoints do not expose a count-tokens endpoint.
	// Delegate to the inner provider (openaiProvider) which returns
	// ErrCountUnsupported, keeping the wrapper honest if that ever changes.
	return w.inner.CountTokens(ctx, req)
}

func (p *azureOpenAIProvider) CountTokens(_ context.Context, _ CountTokensRequest) (int, error) {
	return 0, ErrCountUnsupported
}

// --- Anthropic native implementation ---

// CountTokens calls Anthropic's /v1/messages/count_tokens endpoint via raw
// HTTP (no SDK). Returns the reported input_tokens. Errors (including non-200
// responses) are returned so the caller can fall back to local counting.
func (p *anthropicProvider) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	body := map[string]any{
		"model":    req.Model,
		"messages": p.formatMessages(req.Messages),
		"betas":    []string{"token-counting-2024-11-01"},
	}
	if req.System != "" {
		body["system"] = req.System
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, map[string]any{
				"name":         t.Name,
				"description":  t.Description,
				"input_schema": t.InputSchema,
			})
		}
		body["tools"] = tools
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return 0, FromAnthropicError(fmt.Errorf("marshal count_tokens request: %w", err), 0, "")
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL+"/v1/messages/count_tokens", bytes.NewReader(raw))
	if err != nil {
		return 0, FromAnthropicError(fmt.Errorf("create count_tokens request: %w", err), 0, "")
	}

	httpReq.Header.Set("Content-Type", "application/json")
	apiKey := p.apiKey
	if apiKey == "" {
		apiKey = GetProviderKey(p.id)
	}
	setAuthHeader(httpReq, p.authHeader, apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return 0, FromAnthropicError(err, 0, "")
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			utils.Log("anthropic", fmt.Sprintf("CountTokens: response body close failed: %v", cerr))
		}
	}()

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return 0, FromAnthropicError(fmt.Errorf("read count_tokens response: %w", readErr), resp.StatusCode, "")
	}

	if resp.StatusCode != http.StatusOK {
		return 0, FromAnthropicError(fmt.Errorf("count_tokens returned status %d", resp.StatusCode), resp.StatusCode, string(respBody))
	}

	var parsed struct {
		InputTokens int `json:"input_tokens"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return 0, FromAnthropicError(fmt.Errorf("parse count_tokens response: %w", err), resp.StatusCode, string(respBody))
	}
	utils.Debug("anthropic", fmt.Sprintf("CountTokens: model=%s input_tokens=%d", req.Model, parsed.InputTokens))
	return parsed.InputTokens, nil
}

// --- Google native implementation ---

// CountTokens calls the Gemini :countTokens endpoint via raw HTTP. Returns the
// reported totalTokens. Errors are returned so the caller can fall back.
func (p *googleProvider) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	apiKey := p.apiKey
	if apiKey == "" {
		apiKey = GetProviderKey(p.ID())
	}
	if apiKey == "" && p.authHeader == "" {
		return 0, NewProviderError(ErrAuth, "Google API key not configured", 0, false)
	}

	body := map[string]any{
		"contents": formatGeminiMessages(req.Messages),
	}
	if req.System != "" {
		body["system_instruction"] = map[string]any{
			"role":  "user",
			"parts": []map[string]any{{"text": req.System}},
		}
	}
	if len(req.Tools) > 0 {
		decls := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			decls[i] = map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  t.InputSchema,
			}
		}
		body["tools"] = []map[string]any{{"functionDeclarations": decls}}
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("marshal countTokens request: %v", err), 0, false)
	}

	var url string
	if p.authHeader != "" {
		url = fmt.Sprintf("%s/v1beta/models/%s:countTokens",
			strings.TrimRight(p.baseURL, "/"), req.Model)
	} else {
		url = fmt.Sprintf("%s/v1beta/models/%s:countTokens?key=%s",
			strings.TrimRight(p.baseURL, "/"), req.Model, apiKey)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("create countTokens request: %v", err), 0, false)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if p.authHeader != "" {
		setAuthHeader(httpReq, p.authHeader, apiKey)
	}

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return 0, NewProviderError(ErrNetwork, err.Error(), 0, true)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			utils.Log("google", fmt.Sprintf("CountTokens: response body close failed: %v", cerr))
		}
	}()

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return 0, NewProviderError(ErrNetwork, fmt.Sprintf("read countTokens response: %v", readErr), resp.StatusCode, false)
	}
	if resp.StatusCode != http.StatusOK {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("countTokens returned status %d: %s", resp.StatusCode, string(respBody)), resp.StatusCode, false)
	}

	var parsed struct {
		TotalTokens int `json:"totalTokens"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("parse countTokens response: %v", err), resp.StatusCode, false)
	}
	utils.Debug("google", fmt.Sprintf("CountTokens: model=%s totalTokens=%d", req.Model, parsed.TotalTokens))
	return parsed.TotalTokens, nil
}

// --- Bedrock native implementation ---

// CountTokens calls the Bedrock Converse CountTokens endpoint via raw HTTP with
// AWS SigV4 signing (mirroring Stream's signing path). Returns the reported
// inputTokens. The endpoint shape follows the Converse CountTokens command:
// POST /model/<modelId>/converse/count-tokens with a Converse-compatible body.
// Any error (including a non-200 response) is returned so the caller falls back
// to local counting gracefully.
func (p *bedrockProvider) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	converse := map[string]any{
		"messages": formatBedrockMessages(req.Messages),
	}
	if req.System != "" {
		converse["system"] = []map[string]any{{"text": req.System}}
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = map[string]any{
				"toolSpec": map[string]any{
					"name":        t.Name,
					"description": t.Description,
					"inputSchema": map[string]any{"json": t.InputSchema},
				},
			}
		}
		converse["toolConfig"] = map[string]any{"tools": tools}
	}

	body := map[string]any{
		"input": map[string]any{"converse": converse},
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("marshal count-tokens request: %v", err), 0, false)
	}

	url := fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com/model/%s/count-tokens",
		p.region, req.Model)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("create count-tokens request: %v", err), 0, false)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	if err := p.signV4(httpReq, raw); err != nil {
		return 0, NewProviderError(ErrAuth, fmt.Sprintf("AWS signing failed: %v", err), 0, false)
	}

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return 0, NewProviderError(ErrNetwork, err.Error(), 0, true)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			utils.Log("bedrock", fmt.Sprintf("CountTokens: response body close failed: %v", cerr))
		}
	}()

	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return 0, NewProviderError(ErrNetwork, fmt.Sprintf("read count-tokens response: %v", readErr), resp.StatusCode, false)
	}
	if resp.StatusCode != http.StatusOK {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("count-tokens returned status %d: %s", resp.StatusCode, string(respBody)), resp.StatusCode, false)
	}

	var parsed struct {
		InputTokens int `json:"inputTokens"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return 0, NewProviderError(ErrUnknown, fmt.Sprintf("parse count-tokens response: %v", err), resp.StatusCode, false)
	}
	if parsed.InputTokens == 0 {
		// A zero count with a 200 is treated as "unsupported" so the caller
		// falls back rather than reporting an implausible zero-token prompt.
		return 0, ErrCountUnsupported
	}
	utils.Debug("bedrock", fmt.Sprintf("CountTokens: model=%s inputTokens=%d", req.Model, parsed.InputTokens))
	return parsed.InputTokens, nil
}
