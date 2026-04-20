package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
)

// ProviderOptions configures API key and base URL for a provider.
type ProviderOptions struct {
	ID         string // override provider ID (default: provider-specific)
	APIKey     string
	BaseURL    string
	AuthHeader string // override auth header name (default: provider-specific)
}

type anthropicProvider struct {
	id         string
	apiKey     string
	baseURL    string
	authHeader string // "x-api-key" (default), "bearer", or custom header name
	client     *http.Client
}

// NewAnthropicProvider creates an Anthropic provider that uses raw HTTP SSE
// (no SDK dependency). Events are already in canonical format so translation
// is minimal.
func NewAnthropicProvider(opts *ProviderOptions) LlmProvider {
	apiKey := ""
	baseURL := "https://api.anthropic.com"
	if opts != nil {
		if opts.APIKey != "" {
			apiKey = opts.APIKey
		}
		if opts.BaseURL != "" {
			baseURL = opts.BaseURL
		}
	}
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}

	authHeader := "x-api-key"
	if opts != nil && opts.AuthHeader != "" {
		authHeader = opts.AuthHeader
	}

	id := "anthropic"
	if opts != nil && opts.ID != "" {
		id = opts.ID
	}

	return &anthropicProvider{
		id:         id,
		apiKey:     apiKey,
		baseURL:    baseURL,
		authHeader: authHeader,
		client:     &http.Client{Transport: network.GetHTTPTransport()},
	}
}

func (p *anthropicProvider) ID() string { return p.id }

func (p *anthropicProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errc)

		if err := p.doStream(ctx, opts, events); err != nil {
			errc <- err
		}
	}()

	return events, errc
}

func (p *anthropicProvider) doStream(ctx context.Context, opts types.LlmStreamOptions, events chan<- types.LlmStreamEvent) error {
	body := p.buildRequestBody(opts)

	raw, err := json.Marshal(body)
	if err != nil {
		return FromAnthropicError(fmt.Errorf("marshal request: %w", err), 0, "")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/messages", bytes.NewReader(raw))
	if err != nil {
		return FromAnthropicError(fmt.Errorf("create request: %w", err), 0, "")
	}

	req.Header.Set("Content-Type", "application/json")
	apiKey := p.apiKey
	if apiKey == "" {
		apiKey = GetProviderKey(p.id)
	}
	setAuthHeader(req, p.authHeader, apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.client.Do(req)
	if err != nil {
		return FromAnthropicError(err, 0, "")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return FromAnthropicError(
			fmt.Errorf("anthropic API error: %s", string(respBody)),
			resp.StatusCode,
			string(respBody),
		)
	}

	// Parse SSE stream. Anthropic events are already canonical format.
	for sse := range ParseSSEStream(resp.Body) {
		if sse.Data == "" {
			continue
		}

		var ev types.LlmStreamEvent
		if err := json.Unmarshal([]byte(sse.Data), &ev); err != nil {
			continue // skip malformed events
		}

		// Use the SSE event name as the type if the JSON didn't carry one
		if ev.Type == "" && sse.Event != "" {
			ev.Type = sse.Event
		}

		select {
		case events <- ev:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	return nil
}

func (p *anthropicProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}

	body := map[string]any{
		"model":      opts.Model,
		"max_tokens": maxTokens,
		"stream":     true,
	}

	// System prompt with cache_control for prompt caching
	if opts.System != "" {
		body["system"] = []map[string]any{
			{
				"type":          "text",
				"text":          opts.System,
				"cache_control": map[string]string{"type": "ephemeral"},
			},
		}
	}

	// Format messages
	body["messages"] = p.formatMessages(opts.Messages)

	// Tools (client-side + server-side)
	var allTools []map[string]any
	for _, t := range opts.Tools {
		allTools = append(allTools, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": t.InputSchema,
		})
	}
	for _, st := range opts.ServerTools {
		allTools = append(allTools, st)
	}
	if len(allTools) > 0 {
		body["tools"] = allTools
	}

	// Extended thinking
	if opts.Thinking != nil && opts.Thinking.Enabled {
		budget := 10000
		if opts.Thinking.BudgetTokens > 0 {
			budget = opts.Thinking.BudgetTokens
		}
		body["thinking"] = map[string]any{
			"type":          "enabled",
			"budget_tokens": budget,
		}
	}

	return body
}

func (p *anthropicProvider) formatMessages(messages []types.LlmMessage) []map[string]any {
	result := make([]map[string]any, 0, len(messages))

	for i, msg := range messages {
		blocks := contentBlocks(msg)
		if blocks == nil {
			continue
		}

		formatted := make([]map[string]any, 0, len(blocks))
		for _, block := range blocks {
			fb := formatAnthropicBlock(block)
			if fb != nil {
				formatted = append(formatted, fb)
			}
		}

		// Cache early user messages (first 2 user messages) for prompt caching
		if msg.Role == "user" && i < 4 && len(formatted) > 0 {
			last := formatted[len(formatted)-1]
			if _, hasCacheCtrl := last["cache_control"]; !hasCacheCtrl {
				last["cache_control"] = map[string]string{"type": "ephemeral"}
			}
		}

		result = append(result, map[string]any{
			"role":    msg.Role,
			"content": formatted,
		})
	}

	return result
}

func formatAnthropicBlock(b types.LlmContentBlock) map[string]any {
	switch b.Type {
	case "text":
		return map[string]any{"type": "text", "text": b.Text}
	case "tool_use":
		return map[string]any{
			"type":  "tool_use",
			"id":    b.ID,
			"name":  b.Name,
			"input": b.Input,
		}
	case "tool_result":
		result := map[string]any{
			"type":        "tool_result",
			"tool_use_id": b.ToolUseID,
			"content":     b.Content,
		}
		if b.IsError != nil && *b.IsError {
			result["is_error"] = true
		}
		return result
	case "image":
		if b.Source == nil {
			return nil
		}
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": b.Source.MediaType,
				"data":       b.Source.Data,
			},
		}
	case "thinking":
		return map[string]any{
			"type":      "thinking",
			"thinking":  b.Thinking,
			"signature": "",
		}
	case "server_tool_use":
		return map[string]any{
			"type":  "server_tool_use",
			"id":    b.ID,
			"name":  b.Name,
			"input": b.Input,
		}
	case "web_search_tool_result":
		m := map[string]any{
			"type":        "web_search_tool_result",
			"tool_use_id": b.ToolUseID,
		}
		// Content was stored as JSON string but API expects the raw list
		if b.Content != "" {
			var parsed any
			if err := json.Unmarshal([]byte(b.Content), &parsed); err == nil {
				m["content"] = parsed
			}
		}
		return m
	default:
		// Pass through unknown block types as-is
		m := map[string]any{"type": b.Type}
		if b.Text != "" {
			m["text"] = b.Text
		}
		return m
	}
}
