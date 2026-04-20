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
	if opts != nil {
		if opts.APIKey != "" {
			apiKey = opts.APIKey
		}
		if opts.BaseURL != "" {
			baseURL = opts.BaseURL
		}
	}
	if apiKey == "" {
		apiKey = os.Getenv("OPENAI_API_KEY")
	}

	authHeader := "bearer"
	if opts != nil && opts.AuthHeader != "" {
		authHeader = opts.AuthHeader
	}

	return &openaiProvider{
		id:         "openai",
		apiKey:     apiKey,
		baseURL:    baseURL,
		authHeader: authHeader,
		client:  &http.Client{Transport: network.GetHTTPTransport()},
	}
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
	body := p.buildRequestBody(opts)

	raw, err := json.Marshal(body)
	if err != nil {
		return FromOpenAIError(fmt.Errorf("marshal request: %w", err), 0, "")
	}

	// Build URL: append /chat/completions, or /v1/chat/completions if baseURL doesn't include /v1
	endpoint := p.baseURL + "/v1/chat/completions"
	if strings.HasSuffix(p.baseURL, "/v1") || strings.Contains(p.baseURL, "/v1/") {
		endpoint = strings.TrimRight(p.baseURL, "/") + "/chat/completions"
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
		return FromOpenAIError(err, 0, "")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
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

	for sse := range ParseSSEStream(resp.Body) {
		if sse.Data == "" {
			continue
		}

		var chunk openaiChunk
		if err := json.Unmarshal([]byte(sse.Data), &chunk); err != nil {
			continue
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
			// Close any open block
			if inTextBlock || currentToolID != "" {
				if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
					return err
				}
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

	// message_stop
	return sendEvent(ctx, events, types.LlmStreamEvent{Type: "message_stop"})
}

func (p *openaiProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
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

// --- OpenAI SSE JSON structures ---

type openaiChunk struct {
	ID      string         `json:"id"`
	Choices []openaiChoice `json:"choices"`
	Usage   *openaiUsage   `json:"usage,omitempty"`
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
