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

// openaiResponsesProvider streams via the OpenAI Responses API
// (POST {baseURL}/v1/responses). It implements the same canonical event
// contract as the Chat Completions provider (openai.go) so the run loop is
// agnostic to which OpenAI protocol served the turn. Codex models
// (gpt-*-codex) are Responses-native; enterprise gateways advertise them
// with dialect "openai-responses".
type openaiResponsesProvider struct {
	id         string
	apiKey     string
	baseURL    string
	authHeader string
	client     *http.Client
}

// NewOpenAIResponsesProvider creates a Responses API provider. Options follow
// the same contract as NewOpenAIProvider (ID/BaseURL/AuthHeader overrides for
// gateways and compatible endpoints).
func NewOpenAIResponsesProvider(opts *ProviderOptions) LlmProvider {
	apiKey := ""
	baseURL := "https://api.openai.com"
	id := "openai-responses"
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
	// OPENAI_API_KEY is OpenAI's own credential, so the fallback is gated on
	// OpenAI provider identity (matching NewOpenAIProvider's `id == "openai"`
	// gate). Every gateway inner client is constructed with the gateway's ID,
	// so without this gate a stray OPENAI_API_KEY in the daemon environment
	// would be sent to an unrelated enterprise endpoint as its credential.
	if apiKey == "" && (id == "openai" || id == "openai-responses") {
		apiKey = os.Getenv("OPENAI_API_KEY")
	}

	authHeader := "bearer"
	if opts != nil && opts.AuthHeader != "" {
		authHeader = opts.AuthHeader
	}

	return &openaiResponsesProvider{
		id:         id,
		apiKey:     apiKey,
		baseURL:    baseURL,
		authHeader: authHeader,
		client:     &http.Client{Transport: network.GetHTTPTransport()},
	}
}

func (p *openaiResponsesProvider) ID() string { return p.id }

// CountTokens: the Responses API has no count-tokens endpoint; callers fall
// back to local BPE or char/4, same as the Chat Completions provider.
func (p *openaiResponsesProvider) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	return 0, ErrCountUnsupported
}

func (p *openaiResponsesProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
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

func (p *openaiResponsesProvider) doStream(ctx context.Context, opts types.LlmStreamOptions, events chan<- types.LlmStreamEvent) error {
	utils.LogWithFields(utils.LevelInfo, "OpenAIResponses", "do stream start", map[string]any{"provider": p.id, "model": opts.Model, "path": p.baseURL})
	body := p.buildRequestBody(opts)

	raw, err := json.Marshal(body)
	if err != nil {
		return FromOpenAIError(fmt.Errorf("marshal request: %w", err), 0, "")
	}

	// Build URL: append /responses, or /v1/responses if baseURL doesn't include /v1
	endpoint := p.baseURL + "/v1/responses"
	if strings.HasSuffix(p.baseURL, "/v1") || strings.Contains(p.baseURL, "/v1/") {
		endpoint = strings.TrimRight(p.baseURL, "/") + "/responses"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return FromOpenAIError(fmt.Errorf("create request: %w", err), 0, "")
	}

	req.Header.Set("Content-Type", "application/json")
	apiKey := p.apiKey
	if apiKey == "" {
		apiKey = GetProviderKey(p.id)
	}
	setAuthHeader(req, p.authHeader, apiKey)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := p.client.Do(req)
	if err != nil {
		if pe := ClassifyTransportError(err); pe != nil {
			return pe
		}
		return FromOpenAIError(err, 0, "")
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "OpenAIResponses", "do stream response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body) //nolint:errcheck // best-effort read of error-response body
		utils.LogWithFields(utils.LevelError, "OpenAIResponses", "do stream http error", map[string]any{"status": resp.StatusCode, "path": endpoint, "error": string(respBody)})
		return FromOpenAIError(
			fmt.Errorf("openai responses API error: %s", string(respBody)),
			resp.StatusCode,
			string(respBody),
		)
	}

	// Emit message_start
	if err := sendEvent(ctx, events, types.LlmStreamEvent{
		Type: "message_start",
		MessageInfo: &types.LlmStreamMessageInfo{
			ID:    fmt.Sprintf("msg_openai_responses_%d", time.Now().UnixMilli()),
			Model: opts.Model,
			Usage: types.LlmUsage{},
		},
	}); err != nil {
		return err
	}

	var (
		contentIndex    int
		inTextBlock     bool
		inThinkingBlock bool
		currentToolID   string
		totalInputToks  int
		totalOutputToks int
		sawToolCall     bool
	)

	closeOpenBlock := func() error {
		if inTextBlock || inThinkingBlock || currentToolID != "" {
			if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
				return err
			}
			contentIndex++
			inTextBlock = false
			inThinkingBlock = false
			currentToolID = ""
		}
		return nil
	}

	rawCh, rawErr := ParseSSEStream(resp.Body)
	sseCh, sseErr := streamWithIdle(rawCh, rawErr, p.id, opts.Model, "", nil, telemetryCorrelationFromContext(ctx))
	for sse := range sseCh {
		if sse.Data == "" {
			continue
		}

		var ev responsesStreamEvent
		if err := json.Unmarshal([]byte(sse.Data), &ev); err != nil {
			continue
		}

		switch ev.Type {
		case "response.output_item.added":
			if ev.Item == nil {
				continue
			}
			switch ev.Item.Type {
			case "function_call":
				if err := closeOpenBlock(); err != nil {
					return err
				}
				currentToolID = ev.Item.CallID
				if currentToolID == "" {
					currentToolID = ev.Item.ID
				}
				sawToolCall = true
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type: "tool_use",
						ID:   currentToolID,
						Name: ev.Item.Name,
					},
				}); err != nil {
					return err
				}
			}

		case "response.output_text.delta":
			if ev.Delta == "" {
				continue
			}
			if !inTextBlock {
				if err := closeOpenBlock(); err != nil {
					return err
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
					Text: ev.Delta,
				},
			}); err != nil {
				return err
			}

		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			if ev.Delta == "" {
				continue
			}
			if !inThinkingBlock {
				if err := closeOpenBlock(); err != nil {
					return err
				}
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type: "thinking",
					},
				}); err != nil {
					return err
				}
				inThinkingBlock = true
			}
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type:       "content_block_delta",
				BlockIndex: contentIndex,
				Delta: &types.LlmStreamDelta{
					Type:     "thinking_delta",
					Thinking: ev.Delta,
				},
			}); err != nil {
				return err
			}

		case "response.function_call_arguments.delta":
			if currentToolID == "" || ev.Delta == "" {
				continue
			}
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type:       "content_block_delta",
				BlockIndex: contentIndex,
				Delta: &types.LlmStreamDelta{
					Type:        "input_json_delta",
					PartialJSON: ev.Delta,
				},
			}); err != nil {
				return err
			}

		case "response.output_item.done":
			if err := closeOpenBlock(); err != nil {
				return err
			}

		case "response.completed", "response.incomplete":
			if ev.Response != nil && ev.Response.Usage != nil {
				totalInputToks = ev.Response.Usage.InputTokens
				totalOutputToks = ev.Response.Usage.OutputTokens
			}
			if err := closeOpenBlock(); err != nil {
				return err
			}
			stopReason := "end_turn"
			if sawToolCall {
				stopReason = "tool_use"
			}
			if ev.Type == "response.incomplete" {
				// Incomplete responses carry the reason (usually max output
				// tokens) — translate to the canonical stop reason so the run
				// loop's continuation handling applies.
				stopReason = "max_tokens"
			}
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

		case "response.failed", "error":
			msg := "responses stream failed"
			code := ""
			if ev.Response != nil && ev.Response.Error != nil {
				msg = ev.Response.Error.Message
				code = ev.Response.Error.Code
			} else if ev.Message != "" {
				msg = ev.Message
				code = ev.Code
			}
			utils.LogWithFields(utils.LevelError, "OpenAIResponses", "do stream in-stream error", map[string]any{"provider": p.id, "model": opts.Model, "reason": code, "error": msg})
			return FromOpenAIError(fmt.Errorf("openai responses API error: %s", msg), 0, msg)
		}
	}

	if err := sseErr(); err != nil {
		if pe := ClassifyTransportError(err); pe != nil {
			return pe
		}
		return FromOpenAIError(fmt.Errorf("sse read: %w", err), 0, "")
	}

	return sendEvent(ctx, events, types.LlmStreamEvent{Type: "message_stop"})
}

// buildRequestBody translates canonical stream options into a Responses API
// request. System prompt maps to `instructions`; canonical messages map to
// typed input items (message / function_call / function_call_output).
func (p *openaiResponsesProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	body := map[string]any{
		"model":  opts.Model,
		"stream": true,
		"store":  false,
		"input":  formatResponsesInput(opts.Messages),
	}

	if opts.System != "" {
		body["instructions"] = opts.System
	}

	if maxTokens, ok := resolveMaxOutputTokens(opts); ok {
		body["max_output_tokens"] = maxTokens
	}

	if len(opts.Tools) > 0 {
		tools := make([]map[string]any, len(opts.Tools))
		for i, t := range opts.Tools {
			// Responses API tool shape is flat (no nested "function" object).
			tools[i] = map[string]any{
				"type":        "function",
				"name":        t.Name,
				"description": t.Description,
				"parameters":  t.InputSchema,
			}
		}
		body["tools"] = tools
	}

	// Reasoning effort via the shared capability resolver — same contract as
	// the Chat Completions provider, different body shape.
	if res := resolveThinking(opts.Model, opts.Thinking); res.Mode == "reasoning_effort" && res.Effort != "" {
		body["reasoning"] = map[string]any{"effort": res.Effort}
	}

	if opts.Temperature != nil {
		body["temperature"] = *opts.Temperature
	}

	// Provider-enforced JSON mode. The Responses API carries the format under
	// text.format (ResponseTextParam.format → TextResponseFormatConfiguration
	// in the OpenAI OpenAPI spec), not the Chat Completions top-level
	// response_format key. Same generic ResponseFormat="json_object" input as
	// the Chat client, different body shape — without this, a consumer that
	// asked for enforced JSON silently loses it the moment its model is served
	// by a Responses-dialect gateway and falls back to fence-stripping.
	if opts.ResponseFormat == "json_object" {
		body["text"] = map[string]any{"format": map[string]any{"type": "json_object"}}
	}

	return body
}

// formatResponsesInput translates canonical (Anthropic-shaped) messages into
// Responses API input items.
func formatResponsesInput(messages []types.LlmMessage) []map[string]any {
	var items []map[string]any

	appendMessage := func(role string, parts []map[string]any) {
		if len(parts) == 0 {
			return
		}
		items = append(items, map[string]any{
			"type":    "message",
			"role":    role,
			"content": parts,
		})
	}

	for _, msg := range messages {
		// Simple string content
		if s, ok := msg.Content.(string); ok {
			partType := "input_text"
			if msg.Role == "assistant" {
				partType = "output_text"
			}
			appendMessage(msg.Role, []map[string]any{{"type": partType, "text": s}})
			continue
		}

		blocks := contentBlocks(msg)
		if blocks == nil {
			continue
		}

		var parts []map[string]any
		for _, b := range blocks {
			switch b.Type {
			case "text":
				partType := "input_text"
				if msg.Role == "assistant" {
					partType = "output_text"
				}
				parts = append(parts, map[string]any{"type": partType, "text": b.Text})
			case "image":
				if msg.Role == "user" && b.Source != nil {
					url := fmt.Sprintf("data:%s;base64,%s", b.Source.MediaType, b.Source.Data)
					parts = append(parts, map[string]any{"type": "input_image", "image_url": url})
				}
			case "compact_boundary":
				text := b.Summary
				if text == "" {
					text = "[Previous conversation compacted]"
				}
				parts = append(parts, map[string]any{"type": "input_text", "text": text})
			case "context_injection":
				text := b.Text
				if text == "" {
					text = "[Nested context loaded]"
				}
				parts = append(parts, map[string]any{"type": "input_text", "text": text})
			case "tool_use":
				// Flush accumulated parts as a message first to preserve order.
				appendMessage(msg.Role, parts)
				parts = nil
				inputJSON, _ := json.Marshal(b.Input) //nolint:errcheck // marshal of a local struct
				items = append(items, map[string]any{
					"type":      "function_call",
					"call_id":   b.ID,
					"name":      b.Name,
					"arguments": string(inputJSON),
				})
			case "tool_result":
				appendMessage(msg.Role, parts)
				parts = nil
				items = append(items, map[string]any{
					"type":    "function_call_output",
					"call_id": b.ToolUseID,
					"output":  b.Content,
				})
			}
		}
		appendMessage(msg.Role, parts)
	}

	return items
}

// ─── Responses API SSE event shapes ────────────────────────────────

type responsesStreamEvent struct {
	Type     string                  `json:"type"`
	Delta    string                  `json:"delta,omitempty"`
	Item     *responsesOutputItem    `json:"item,omitempty"`
	Response *responsesResponseState `json:"response,omitempty"`
	// Top-level error event fields (type == "error")
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`
}

type responsesOutputItem struct {
	Type   string `json:"type"`
	ID     string `json:"id,omitempty"`
	CallID string `json:"call_id,omitempty"`
	Name   string `json:"name,omitempty"`
}

type responsesResponseState struct {
	Usage *responsesUsage `json:"usage,omitempty"`
	Error *responsesError `json:"error,omitempty"`
}

type responsesUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type responsesError struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}
