package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type openaiProvider struct {
	id         string
	apiKey     string
	baseURL    string
	authHeader string // "bearer" (default) or "x-api-key"
	client     *http.Client
}

// NewOpenAIProvider creates an OpenAI provider that uses raw HTTP SSE and
// translates OpenAI streaming events to Anthropic canonical format.
func NewOpenAIProvider(opts *ProviderOptions) LlmProvider {
	apiKey := ""
	baseURL := "https://api.openai.com"
	id := "openai"
	if opts != nil {
		if opts.APIKey != "" {
			apiKey = opts.APIKey
		}
		if opts.BaseURL != "" {
			baseURL = opts.BaseURL
		}
		if opts.ID != "" {
			id = opts.ID
		}
	}
	if apiKey == "" && id == "openai" {
		apiKey = os.Getenv("OPENAI_API_KEY")
	}

	authHeader := "bearer"
	if opts != nil && opts.AuthHeader != "" {
		authHeader = opts.AuthHeader
	}

	result := &openaiProvider{
		id:         id,
		apiKey:     apiKey,
		baseURL:    baseURL,
		authHeader: authHeader,
		client:  &http.Client{Transport: network.GetHTTPTransport()},
	}
	utils.Log("OpenAI", fmt.Sprintf("NewOpenAIProvider: id=%s baseURL=%s apiKeyLen=%d authHeader=%s", id, baseURL, len(apiKey), authHeader))
	return result
}

func (p *openaiProvider) ID() string { return p.id }

func (p *openaiProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
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

func (p *openaiProvider) doStream(ctx context.Context, opts types.LlmStreamOptions, events chan<- types.LlmStreamEvent) error {
	utils.Log("OpenAI", fmt.Sprintf("doStream: id=%s model=%s baseURL=%s", p.id, opts.Model, p.baseURL))
	body := p.buildRequestBody(opts)

	raw, err := json.Marshal(body)
	if err != nil {
		utils.Error("OpenAI", fmt.Sprintf("doStream: marshal error: %v", err))
		return FromOpenAIError(fmt.Errorf("marshal request: %w", err), 0, "")
	}

	// Build URL: append /chat/completions, or /v1/chat/completions if baseURL doesn't include /v1
	endpoint := p.baseURL + "/v1/chat/completions"
	if strings.HasSuffix(p.baseURL, "/v1") || strings.Contains(p.baseURL, "/v1/") {
		endpoint = strings.TrimRight(p.baseURL, "/") + "/chat/completions"
	}
	utils.Log("OpenAI", fmt.Sprintf("doStream: endpoint=%s", endpoint))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		utils.Error("OpenAI", fmt.Sprintf("doStream: create request error: %v", err))
		return FromOpenAIError(fmt.Errorf("create request: %w", err), 0, "")
	}

	req.Header.Set("Content-Type", "application/json")
	apiKey := p.apiKey
	keySource := "constructor"
	if apiKey == "" {
		apiKey = GetProviderKey(p.id)
		keySource = "registry:" + p.id
	}
	utils.Log("OpenAI", fmt.Sprintf("doStream: auth id=%s keySource=%s keyLen=%d authStyle=%s", p.id, keySource, len(apiKey), p.authHeader))
	setAuthHeader(req, p.authHeader, apiKey)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.client.Do(req)
	if err != nil {
		return FromOpenAIError(err, 0, "")
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.Log("OpenAI", fmt.Sprintf("doStream: response body close failed: %v", err))
		}
	}()
	utils.Debug("OpenAI", fmt.Sprintf("doStream: HTTP response status=%d", resp.StatusCode))

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		utils.Error("OpenAI", fmt.Sprintf("doStream: HTTP %d error for %s: %s", resp.StatusCode, endpoint, string(respBody)))
		return FromOpenAIError(
			fmt.Errorf("openai API error: %s", string(respBody)),
			resp.StatusCode,
			string(respBody),
		)
	}

	// Emit message_start
	msgStart := types.LlmStreamEvent{
		Type: "message_start",
		MessageInfo: &types.LlmStreamMessageInfo{
			ID:    fmt.Sprintf("msg_openai_%d", time.Now().UnixMilli()),
			Model: opts.Model,
			Usage: types.LlmUsage{},
		},
	}
	select {
	case events <- msgStart:
	case <-ctx.Done():
		return ctx.Err()
	}

	var (
		contentIndex    int
		inTextBlock     bool
		currentToolID   string
		totalInputToks  int
		totalOutputToks int
	)

	sseCh, sseErr := ParseSSEStream(resp.Body)
	for sse := range sseCh {
		if sse.Data == "" {
			continue
		}

		var chunk openaiChunk
		if err := json.Unmarshal([]byte(sse.Data), &chunk); err != nil {
			continue
		}

		// In-stream error object. OpenAI-compatible providers (OpenRouter,
		// etc.) signal an upstream/transient failure mid-stream as a valid
		// JSON chunk carrying a top-level {"error": {...}} — often with empty
		// choices. The SSE parse succeeds, so without this branch the failure
		// would be silently dropped by the empty-choices continue below and
		// the turn would complete as a successful empty response. Convert it
		// to a *ProviderError and return so WithRetry / the run loop surface
		// it as a real error (see Defect 2 in the #229 fix plan).
		if chunk.Error != nil {
			pe := p.providerErrorFromStream(chunk.Error)
			utils.Error("OpenAI", fmt.Sprintf("doStream: in-stream error chunk: id=%s model=%s code=%s retryable=%v msg=%s", p.id, opts.Model, pe.Code, pe.Retryable, pe.Message))
			return pe
		}

		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]
		delta := choice.Delta

		// Usage
		if chunk.Usage != nil {
			totalInputToks = chunk.Usage.PromptTokens
			totalOutputToks = chunk.Usage.CompletionTokens
		}

		// Text content
		if delta.Content != "" {
			if !inTextBlock {
				// Close any open tool block first
				if currentToolID != "" {
					if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
						return err
					}
					contentIndex++
					currentToolID = ""
				}
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type: "text",
						Text: "",
					},
				}); err != nil {
					return err
				}
				inTextBlock = true
			}
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type:       "content_block_delta",
				BlockIndex: contentIndex,
				Delta: &types.LlmStreamDelta{
					Type: "text_delta",
					Text: delta.Content,
				},
			}); err != nil {
				return err
			}
		}

		// Tool calls
		for _, tc := range delta.ToolCalls {
			if tc.ID != "" {
				// Close previous block
				if inTextBlock || currentToolID != "" {
					if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
						return err
					}
					contentIndex++
					inTextBlock = false
				}
				currentToolID = tc.ID
				name := ""
				if tc.Function != nil {
					name = tc.Function.Name
				}
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type: "tool_use",
						ID:   tc.ID,
						Name: name,
					},
				}); err != nil {
					return err
				}
			}
			if tc.Function != nil && tc.Function.Arguments != "" {
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_delta",
					BlockIndex: contentIndex,
					Delta: &types.LlmStreamDelta{
						Type:        "input_json_delta",
						PartialJSON: tc.Function.Arguments,
					},
				}); err != nil {
					return err
				}
			}
		}

		// Finish reason
		if choice.FinishReason != "" {
			// Defect 2: a finish_reason of "error" is an upstream/transient
			// failure carried in-band (often alongside a chunk-level error
			// object). Convert it to a *ProviderError and return so the
			// existing retry + error-surfacing path handles it, instead of
			// translating it to a literal "error" stop reason that the run
			// loop would treat as a successful empty turn.
			if choice.FinishReason == "error" {
				pe := p.providerErrorFromStream(chunk.Error)
				utils.Error("OpenAI", fmt.Sprintf("doStream: finish_reason=error: id=%s model=%s code=%s retryable=%v msg=%s", p.id, opts.Model, pe.Code, pe.Retryable, pe.Message))
				return pe
			}
			// Close any open block
			if inTextBlock || currentToolID != "" {
				if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
					return err
				}
				// Defect 1 (layer 2): reset block state after emitting the
				// stop so a trailing chunk that also carries a finish_reason
				// cannot emit a second content_block_stop for the same block
				// (which downstream would clobber the parsed tool input).
				inTextBlock = false
				currentToolID = ""
			}
			stopReason := translateFinishReason(choice.FinishReason)
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type: "message_delta",
				Delta: &types.LlmStreamDelta{
					Type:       "message_delta",
					StopReason: &stopReason,
				},
				DeltaUsage: &types.LlmUsage{
					InputTokens:  totalInputToks,
					OutputTokens: totalOutputToks,
				},
			}); err != nil {
				return err
			}
		}
	}

	// Surface mid-stream read failures as real errors instead of silently
	// closing the turn with a synthetic message_stop on a partial response.
	if err := sseErr(); err != nil {
		if pe := ClassifyTransportError(err); pe != nil {
			return pe
		}
		return FromOpenAIError(fmt.Errorf("sse read: %w", err), 0, "")
	}

	// message_stop
	return sendEvent(ctx, events, types.LlmStreamEvent{Type: "message_stop"})
}

func (p *openaiProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 16384
	}

	body := map[string]any{
		"model":                  opts.Model,
		"max_completion_tokens":  maxTokens,
		"stream":                 true,
		"messages":               formatOpenAIMessages(opts.System, opts.Messages),
	}

	if len(opts.Tools) > 0 {
		tools := make([]map[string]any, len(opts.Tools))
		for i, t := range opts.Tools {
			tools[i] = map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        t.Name,
					"description": t.Description,
					"parameters":  t.InputSchema,
				},
			}
		}
		body["tools"] = tools
	}

	if opts.Thinking != nil && opts.Thinking.Enabled {
		body["reasoning_effort"] = "high"
	}

	// Temperature: forward when the caller set it (pointer non-nil). A
	// deliberate 0.0 is meaningful (deterministic), so we forward it too.
	if opts.Temperature != nil {
		body["temperature"] = *opts.Temperature
	}

	// Provider-enforced JSON mode for OpenAI-compatible providers. Maps the
	// generic ResponseFormat="json_object" to the OpenAI response_format
	// object so the provider guarantees valid JSON output rather than the
	// engine relying on best-effort fence-stripping.
	if opts.ResponseFormat == "json_object" {
		body["response_format"] = map[string]any{"type": "json_object"}
	}

	return body
}

// formatOpenAIMessages translates canonical (Anthropic) messages to OpenAI format.
func formatOpenAIMessages(system string, messages []types.LlmMessage) []map[string]any {
	result := []map[string]any{
		{"role": "system", "content": system},
	}

	for _, msg := range messages {
		blocks := contentBlocks(msg)

		// Simple string content
		if s, ok := msg.Content.(string); ok {
			result = append(result, map[string]any{"role": msg.Role, "content": s})
			continue
		}

		if blocks == nil {
			continue
		}

		// Separate tool_result blocks (they become separate "tool" messages)
		var toolResults []types.LlmContentBlock
		var otherBlocks []types.LlmContentBlock
		for _, b := range blocks {
			if b.Type == "tool_result" {
				toolResults = append(toolResults, b)
			} else {
				otherBlocks = append(otherBlocks, b)
			}
		}

		// Assistant messages with tool_use blocks
		if msg.Role == "assistant" {
			var toolUses []map[string]any
			var textParts []string
			for _, b := range otherBlocks {
				switch b.Type {
				case "tool_use":
					inputJSON, _ := json.Marshal(b.Input)
					toolUses = append(toolUses, map[string]any{
						"id":   b.ID,
						"type": "function",
						"function": map[string]any{
							"name":      b.Name,
							"arguments": string(inputJSON),
						},
					})
				case "text":
					textParts = append(textParts, b.Text)
				}
			}

			if len(toolUses) > 0 {
				m := map[string]any{
					"role":       "assistant",
					"tool_calls": toolUses,
				}
				if len(textParts) > 0 {
					combined := ""
					for _, t := range textParts {
						combined += t
					}
					m["content"] = combined
				}
				result = append(result, m)
			} else if len(textParts) > 0 {
				combined := ""
				for _, t := range textParts {
					combined += t
				}
				result = append(result, map[string]any{"role": "assistant", "content": combined})
			}
		}

		// User messages
		if msg.Role == "user" {
			var parts []map[string]any
			for _, b := range otherBlocks {
				switch b.Type {
				case "text":
					parts = append(parts, map[string]any{"type": "text", "text": b.Text})
				case "image":
					if b.Source != nil {
						url := fmt.Sprintf("data:%s;base64,%s", b.Source.MediaType, b.Source.Data)
						parts = append(parts, map[string]any{
							"type":      "image_url",
							"image_url": map[string]any{"url": url},
						})
					}
				case "compact_boundary":
					// Flatten the engine-internal compaction marker to a
					// plain text part so the model still sees the
					// rendered summary in context. See the matching case
					// in anthropic.go formatAnthropicBlock for rationale.
					text := b.Summary
					if text == "" {
						text = "[Previous conversation compacted]"
					}
					parts = append(parts, map[string]any{"type": "text", "text": text})
				}
			}
			if len(parts) > 0 {
				result = append(result, map[string]any{"role": "user", "content": parts})
			}
		}

		// Tool results as separate messages
		for _, tr := range toolResults {
			result = append(result, map[string]any{
				"role":         "tool",
				"tool_call_id": tr.ToolUseID,
				"content":      tr.Content,
			})
		}
	}

	return result
}

func translateFinishReason(reason string) string {
	switch reason {
	case "tool_calls":
		return "tool_use"
	case "stop":
		return "end_turn"
	default:
		return reason
	}
}

func sendEvent(ctx context.Context, ch chan<- types.LlmStreamEvent, ev types.LlmStreamEvent) error {
	select {
	case ch <- ev:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// providerErrorFromStream converts an in-stream error object into a
// *ProviderError. Retryability is derived from the provider error's own
// code/type/message — NOT from HTTP status — because in-stream errors arrive
// over an HTTP 200 response (the failure is in the SSE body), so the
// status-based classifier in FromOpenAIError never fires for them. Known
// terminal codes (invalid model, content filter, auth, invalid request) map
// to non-retryable; genuinely unknown in-stream errors default to retryable
// so transient upstream blips get the existing WithRetry budget.
//
// A nil error object (a bare finish_reason="error" with no payload) yields a
// retryable unknown error so the failure is still surfaced rather than
// swallowed.
func (p *openaiProvider) providerErrorFromStream(se *openaiStreamError) *ProviderError {
	if se == nil {
		return &ProviderError{Code: ErrUnknown, Message: "provider signalled an in-stream error with no detail", Retryable: true}
	}

	code := strings.ToLower(se.normalizedCode())
	typ := strings.ToLower(se.Type)
	msg := se.Message
	if msg == "" {
		msg = "provider in-stream error"
	}
	haystack := code + " " + typ + " " + strings.ToLower(msg)

	switch {
	case strings.Contains(haystack, "content_filter"),
		strings.Contains(haystack, "content policy"),
		strings.Contains(haystack, "content_policy"):
		return &ProviderError{Code: ErrContentFilter, Message: msg, Retryable: false}
	case strings.Contains(haystack, "model_not_found"),
		strings.Contains(haystack, "invalid_model"),
		strings.Contains(haystack, "does not exist"),
		strings.Contains(haystack, "unknown model"):
		return &ProviderError{Code: ErrInvalidModel, Message: msg, Retryable: false}
	case strings.Contains(haystack, "authentication"),
		strings.Contains(haystack, "unauthorized"),
		strings.Contains(haystack, "invalid_api_key"),
		strings.Contains(haystack, "invalid api key"),
		typ == "auth", code == "auth":
		return &ProviderError{Code: ErrAuth, Message: msg, Retryable: false}
	case strings.Contains(haystack, "too long"),
		strings.Contains(haystack, "maximum context"),
		strings.Contains(haystack, "context length"):
		return &ProviderError{Code: ErrPromptTooLong, Message: msg, Retryable: false}
	case strings.Contains(haystack, "invalid_request"),
		strings.Contains(haystack, "invalid request"):
		return &ProviderError{Code: ErrInvalidReq, Message: msg, Retryable: false}
	case strings.Contains(haystack, "rate_limit"),
		strings.Contains(haystack, "rate limit"):
		return &ProviderError{Code: ErrRateLimit, Message: msg, Retryable: true}
	case strings.Contains(haystack, "overloaded"):
		return &ProviderError{Code: ErrOverloaded, Message: msg, Retryable: true}
	default:
		// Unknown in-stream error: default to retryable so transient upstream
		// failures get the existing retry budget. Exhausted retries still
		// surface as a non-zero exit via the run loop's streamErr path.
		return &ProviderError{Code: ErrUnknown, Message: msg, Retryable: true}
	}
}

// --- OpenAI SSE JSON structures ---

type openaiChunk struct {
	ID      string             `json:"id"`
	Choices []openaiChoice     `json:"choices"`
	Usage   *openaiUsage       `json:"usage,omitempty"`
	Error   *openaiStreamError `json:"error,omitempty"`
}

// openaiStreamError is the in-stream error object some OpenAI-compatible
// providers emit mid-stream (e.g. OpenRouter). Code is decoded as
// json.RawMessage because providers are inconsistent about its type: some
// send a string ("model_not_found"), others a number. A bare string field
// would fail to unmarshal a numeric code and abort the entire chunk decode,
// which the doStream loop's continue would then silently swallow.
type openaiStreamError struct {
	Message string          `json:"message"`
	Type    string          `json:"type"`
	Code    json.RawMessage `json:"code"`
}

// normalizedCode renders the raw error code as a string regardless of whether
// the provider sent a JSON string or a JSON number. Returns "" when absent.
func (e *openaiStreamError) normalizedCode() string {
	if e == nil || len(e.Code) == 0 {
		return ""
	}
	// Try string first (the common case), then fall back to the raw bytes
	// (covers numeric codes like 503 and any other JSON scalar).
	var s string
	if err := json.Unmarshal(e.Code, &s); err == nil {
		return s
	}
	return strings.Trim(string(e.Code), "\"")
}

type openaiChoice struct {
	Delta        openaiDelta `json:"delta"`
	FinishReason string      `json:"finish_reason"`
}

type openaiDelta struct {
	Content   string           `json:"content"`
	ToolCalls []openaiToolCall `json:"tool_calls"`
}

type openaiToolCall struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Function *openaiFunction `json:"function,omitempty"`
}

type openaiFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openaiUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}
