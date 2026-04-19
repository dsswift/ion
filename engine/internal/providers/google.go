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

type googleProvider struct {
	apiKey     string
	baseURL    string
	authHeader string // "" = key-in-url (default), "bearer", "x-api-key", etc.
	client     *http.Client
}

// NewGoogleProvider creates a Google Gemini provider that uses raw HTTP streaming
// and translates to Anthropic canonical format.
func NewGoogleProvider(opts *ProviderOptions) LlmProvider {
	apiKey := ""
	if opts != nil && opts.APIKey != "" {
		apiKey = opts.APIKey
	}
	if apiKey == "" {
		apiKey = os.Getenv("GOOGLE_API_KEY")
	}
	if apiKey == "" {
		apiKey = os.Getenv("GEMINI_API_KEY")
	}

	baseURL := "https://generativelanguage.googleapis.com"
	authHeader := ""
	if opts != nil {
		if opts.BaseURL != "" {
			baseURL = opts.BaseURL
		}
		if opts.AuthHeader != "" {
			authHeader = opts.AuthHeader
		}
	}

	return &googleProvider{
		apiKey:     apiKey,
		baseURL:    baseURL,
		authHeader: authHeader,
		client:     &http.Client{Transport: network.GetHTTPTransport()},
	}
}

func (p *googleProvider) ID() string { return "google" }

func (p *googleProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
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

func (p *googleProvider) doStream(ctx context.Context, opts types.LlmStreamOptions, events chan<- types.LlmStreamEvent) error {
	if p.apiKey == "" {
		return NewProviderError(ErrAuth, "Google API key not configured. Set GOOGLE_API_KEY or GEMINI_API_KEY", 0, false)
	}

	// Build URL: native Gemini uses key-in-url, custom gateway uses header auth
	var url string
	if p.authHeader != "" {
		// Gateway/proxy: key in header, no query param
		url = fmt.Sprintf("%s/v1beta/models/%s:streamGenerateContent?alt=sse",
			strings.TrimRight(p.baseURL, "/"), opts.Model)
	} else {
		// Native Gemini API: key in query param
		url = fmt.Sprintf("%s/v1beta/models/%s:streamGenerateContent?key=%s&alt=sse",
			strings.TrimRight(p.baseURL, "/"), opts.Model, p.apiKey)
	}

	body := p.buildRequestBody(opts)
	raw, err := json.Marshal(body)
	if err != nil {
		return NewProviderError(ErrUnknown, fmt.Sprintf("marshal request: %v", err), 0, false)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return NewProviderError(ErrUnknown, fmt.Sprintf("create request: %v", err), 0, false)
	}
	req.Header.Set("Content-Type", "application/json")
	if p.authHeader != "" {
		setAuthHeader(req, p.authHeader, p.apiKey)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return NewProviderError(ErrNetwork, err.Error(), 0, true)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return classifyGeminiError(resp.StatusCode, string(respBody))
	}

	// Emit message_start
	if err := sendEvent(ctx, events, types.LlmStreamEvent{
		Type: "message_start",
		MessageInfo: &types.LlmStreamMessageInfo{
			ID:    fmt.Sprintf("msg_google_%d", time.Now().UnixMilli()),
			Model: opts.Model,
			Usage: types.LlmUsage{},
		},
	}); err != nil {
		return err
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

		var chunk geminiResponse
		if err := json.Unmarshal([]byte(sse.Data), &chunk); err != nil {
			continue
		}

		if chunk.UsageMetadata != nil {
			totalInputToks = chunk.UsageMetadata.PromptTokenCount
			totalOutputToks = chunk.UsageMetadata.CandidatesTokenCount
		}

		if len(chunk.Candidates) == 0 {
			continue
		}
		candidate := chunk.Candidates[0]

		for _, part := range candidate.Content.Parts {
			// Text content
			if part.Text != "" {
				if !inTextBlock {
					if currentToolID != "" {
						if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
							return err
						}
						contentIndex++
						currentToolID = ""
					}
					if err := sendEvent(ctx, events, types.LlmStreamEvent{
						Type:         "content_block_start",
						BlockIndex:   contentIndex,
						ContentBlock: &types.LlmStreamContentBlock{Type: "text", Text: ""},
					}); err != nil {
						return err
					}
					inTextBlock = true
				}
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_delta",
					BlockIndex: contentIndex,
					Delta:      &types.LlmStreamDelta{Type: "text_delta", Text: part.Text},
				}); err != nil {
					return err
				}
			}

			// Function calls
			if part.FunctionCall != nil {
				if inTextBlock || currentToolID != "" {
					if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
						return err
					}
					contentIndex++
					inTextBlock = false
				}
				toolID := fmt.Sprintf("call_%d_%d", time.Now().UnixMilli(), contentIndex)
				currentToolID = toolID
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type: "tool_use",
						ID:   toolID,
						Name: part.FunctionCall.Name,
					},
				}); err != nil {
					return err
				}
				argsJSON, _ := json.Marshal(part.FunctionCall.Args)
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_delta",
					BlockIndex: contentIndex,
					Delta:      &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: string(argsJSON)},
				}); err != nil {
					return err
				}
			}
		}

		// Check finish reason
		if candidate.FinishReason != "" {
			if inTextBlock || currentToolID != "" {
				if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
					return err
				}
			}
			stopReason := "end_turn"
			if candidate.FinishReason == "MAX_TOKENS" {
				stopReason = "max_tokens"
			}
			if err := sendEvent(ctx, events, types.LlmStreamEvent{
				Type:  "message_delta",
				Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason},
				DeltaUsage: &types.LlmUsage{
					InputTokens:  totalInputToks,
					OutputTokens: totalOutputToks,
				},
			}); err != nil {
				return err
			}
		}
	}

	return sendEvent(ctx, events, types.LlmStreamEvent{Type: "message_stop"})
}

func (p *googleProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	maxTokens := opts.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}

	body := map[string]any{
		"contents":         formatGeminiMessages(opts.Messages),
		"generationConfig": map[string]any{"maxOutputTokens": maxTokens},
	}

	if opts.System != "" {
		body["systemInstruction"] = map[string]any{
			"role":  "user",
			"parts": []map[string]any{{"text": opts.System}},
		}
	}

	if len(opts.Tools) > 0 {
		decls := make([]map[string]any, len(opts.Tools))
		for i, t := range opts.Tools {
			decls[i] = map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  t.InputSchema,
			}
		}
		body["tools"] = []map[string]any{{"functionDeclarations": decls}}
	}

	return body
}

func formatGeminiMessages(messages []types.LlmMessage) []map[string]any {
	var contents []map[string]any
	for _, msg := range messages {
		role := msg.Role
		if role == "assistant" {
			role = "model"
		}

		blocks := contentBlocks(msg)
		if blocks == nil {
			if s, ok := msg.Content.(string); ok {
				contents = append(contents, map[string]any{
					"role":  role,
					"parts": []map[string]any{{"text": s}},
				})
			}
			continue
		}

		var parts []map[string]any
		for _, b := range blocks {
			switch b.Type {
			case "text":
				parts = append(parts, map[string]any{"text": b.Text})
			case "tool_use":
				parts = append(parts, map[string]any{
					"functionCall": map[string]any{
						"name": b.Name,
						"args": b.Input,
					},
				})
			case "tool_result":
				parts = append(parts, map[string]any{
					"functionResponse": map[string]any{
						"name":     b.ToolUseID,
						"response": map[string]any{"content": b.Content},
					},
				})
			case "image":
				if b.Source != nil {
					parts = append(parts, map[string]any{
						"inlineData": map[string]any{
							"mimeType": b.Source.MediaType,
							"data":     b.Source.Data,
						},
					})
				}
			}
		}
		if len(parts) > 0 {
			contents = append(contents, map[string]any{"role": role, "parts": parts})
		}
	}
	return contents
}

func classifyGeminiError(status int, body string) *ProviderError {
	msg := fmt.Sprintf("Google API error (HTTP %d): %s", status, body)
	if status == 401 || status == 403 {
		return NewProviderError(ErrAuth, msg, status, false)
	}
	if status == 429 {
		return NewProviderError(ErrRateLimit, msg, 429, true)
	}
	if status >= 500 {
		return NewProviderError(ErrOverloaded, msg, status, true)
	}
	return NewProviderError(ErrUnknown, msg, status, false)
}

// --- Gemini response structures ---

type geminiResponse struct {
	Candidates    []geminiCandidate `json:"candidates"`
	UsageMetadata *geminiUsage      `json:"usageMetadata,omitempty"`
}

type geminiCandidate struct {
	Content      geminiContent `json:"content"`
	FinishReason string        `json:"finishReason,omitempty"`
}

type geminiContent struct {
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text         string              `json:"text,omitempty"`
	FunctionCall *geminiFunctionCall `json:"functionCall,omitempty"`
}

type geminiFunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type geminiUsage struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
}
