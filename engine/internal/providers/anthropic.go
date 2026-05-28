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
	"github.com/dsswift/ion/engine/internal/utils"
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
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.Log("anthropic", fmt.Sprintf("Stream: response body close failed: %v", err))
		}
	}()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return FromAnthropicError(
			fmt.Errorf("anthropic API error: %s", string(respBody)),
			resp.StatusCode,
			string(respBody),
		)
	}

	// Parse SSE stream. Anthropic events are already canonical format.
	gotMessageStop := false
	var streamErrEvent *anthropicStreamError
	sseCh, sseErr := ParseSSEStream(resp.Body)
	for sse := range sseCh {
		if sse.Data == "" {
			continue
		}

		// Anthropic emits an `event: error` mid-stream when the upstream model
		// returns overloaded_error, rate-limit, or other inflight failures.
		// Capture the typed payload so we can classify it correctly instead of
		// falling through to a generic stream_truncated.
		if sse.Event == "error" {
			var se anthropicStreamError
			if err := json.Unmarshal([]byte(sse.Data), &se); err == nil && se.Error.Type != "" {
				streamErrEvent = &se
			}
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

		if ev.Type == "message_stop" {
			gotMessageStop = true
		}

		select {
		case events <- ev:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	// A streaming error event from Anthropic is the actual cause — surface it
	// with the right code so retries back off appropriately and the user sees
	// what's wrong.
	if streamErrEvent != nil {
		return streamErrEvent.toProviderError()
	}

	// Surface the real underlying read error (TCP RST, h2 GOAWAY,
	// ErrUnexpectedEOF, etc) instead of synthesizing a generic
	// stream_truncated. ClassifyTransportError tags it so WithRetry can
	// recover and so logs show the actual cause.
	if err := sseErr(); err != nil {
		if pe := ClassifyTransportError(err); pe != nil {
			return pe
		}
		return FromAnthropicError(fmt.Errorf("sse read: %w", err), 0, "")
	}

	if !gotMessageStop {
		return &ProviderError{
			Message:   "SSE stream ended without message_stop (connection interrupted)",
			Code:      ErrStreamTruncated,
			Retryable: true,
		}
	}

	return nil
}

func (p *anthropicProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 16384
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
	allTools = append(allTools, opts.ServerTools...)
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

	for _, msg := range messages {
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

		result = append(result, map[string]any{
			"role":    msg.Role,
			"content": formatted,
		})
	}

	// Apply cache_control to the last N user messages (walking backwards).
	// Budget: Anthropic allows max 4 cache_control blocks per request;
	// 1 is used by the system prompt, leaving 3 for messages.
	const messageCacheBudget = 3
	remaining := messageCacheBudget
	for i := len(result) - 1; i >= 0 && remaining > 0; i-- {
		if result[i]["role"] != "user" {
			continue
		}
		content, ok := result[i]["content"].([]map[string]any)
		if !ok || len(content) == 0 {
			continue
		}
		last := content[len(content)-1]
		if _, hasCacheCtrl := last["cache_control"]; !hasCacheCtrl {
			last["cache_control"] = map[string]string{"type": "ephemeral"}
		}
		remaining--
	}

	return result
}

func formatAnthropicBlock(b types.LlmContentBlock) map[string]any {
	switch b.Type {
	case "text":
		return map[string]any{"type": "text", "text": b.Text}
	case "tool_use":
		// The Anthropic API rejects tool_use whose input is not a JSON
		// object. Defensive guard so a nil Input never poisons a
		// retried conversation.
		input := b.Input
		if input == nil {
			input = map[string]any{}
		}
		return map[string]any{
			"type":  "tool_use",
			"id":    b.ID,
			"name":  b.Name,
			"input": input,
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
	case "compact_boundary":
		// compact_boundary is an engine-internal structural marker that
		// providers must never see on the wire (unknown block types are
		// rejected by Anthropic and silently dropped by OpenAI). Flatten
		// to a text block carrying the rendered Summary so the model
		// still sees the post-compaction summary in context. The
		// structured fields (Trigger, ClearedBlocks, …) are
		// engine-internal only — they round-trip through persistence but
		// are not forwarded to providers.
		text := b.Summary
		if text == "" {
			// Defensive: a boundary with no rendered summary still needs
			// a non-empty text body so Anthropic accepts the message.
			text = "[Previous conversation compacted]"
		}
		return map[string]any{"type": "text", "text": text}
	default:
		// Pass through unknown block types as-is
		m := map[string]any{"type": b.Type}
		if b.Text != "" {
			m["text"] = b.Text
		}
		return m
	}
}

// anthropicStreamError is the payload of an SSE `event: error` emitted by
// Anthropic mid-stream (overloaded_error, api_error, rate_limit_error, etc).
// See https://docs.anthropic.com/en/api/messages-streaming#error-events
type anthropicStreamError struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
	RequestID string `json:"request_id,omitempty"`
}

func (e *anthropicStreamError) toProviderError() *ProviderError {
	msg := e.Error.Message
	if msg == "" {
		msg = e.Error.Type
	}
	if e.RequestID != "" {
		msg = fmt.Sprintf("%s (request_id=%s)", msg, e.RequestID)
	}
	switch e.Error.Type {
	case "overloaded_error":
		return &ProviderError{Code: ErrOverloaded, Message: msg, Retryable: true}
	case "rate_limit_error":
		return &ProviderError{Code: ErrRateLimit, Message: msg, Retryable: true}
	case "api_error", "timeout_error":
		return &ProviderError{Code: ErrOverloaded, Message: msg, Retryable: true}
	case "authentication_error", "permission_error":
		return &ProviderError{Code: ErrAuth, Message: msg, Retryable: false}
	case "invalid_request_error":
		return &ProviderError{Code: ErrInvalidReq, Message: msg, Retryable: false}
	default:
		return &ProviderError{Code: ErrUnknown, Message: msg, Retryable: true}
	}
}
