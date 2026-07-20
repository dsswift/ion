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
	apiKey := p.apiKey
	if apiKey == "" {
		apiKey = GetProviderKey(p.ID())
	}
	if apiKey == "" {
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
			strings.TrimRight(p.baseURL, "/"), opts.Model, apiKey)
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
		apiKey := p.apiKey
		if apiKey == "" {
			apiKey = GetProviderKey(p.ID())
		}
		setAuthHeader(req, p.authHeader, apiKey)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		// Try transport classification first so "use of closed network
		// connection" and similar are tagged stale_connection (matching the
		// SSE-read path) instead of a generic network error.
		if pe := ClassifyTransportError(err); pe != nil {
			return pe
		}
		return NewProviderError(ErrNetwork, err.Error(), 0, true)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "google", "stream response body close failed", map[string]any{"error": err.Error()})
		}
	}()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body) //nolint:errcheck // best-effort read of an error-response body
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

	rawCh, rawErr := ParseSSEStream(resp.Body)
	// Per-event idle deadline + heartbeat (see sse_idle.go): a stream that
	// returns headers then goes silent is caught fast and retried.
	sseCh, sseErr := streamWithIdle(rawCh, rawErr, "google", opts.Model, "", nil, telemetryCorrelationFromContext(ctx))
	for sse := range sseCh {
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
				argsJSON, _ := json.Marshal(part.FunctionCall.Args) //nolint:errcheck // marshal of a local struct
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_delta",
					BlockIndex: contentIndex,
					Delta:      &types.LlmStreamDelta{Type: "input_json_delta", PartialJSON: string(argsJSON)},
				}); err != nil {
					return err
				}
			}

			// Provider-generated image (Gemini image output). Close any open
			// block, then emit a self-contained image content block (start +
			// stop) carrying base64 bytes + MIME type. The backend runloop saves
			// the bytes and emits the path-bearing ImageContentEvent — the
			// provider never touches disk. Empty payloads are skipped.
			if part.InlineData != nil && part.InlineData.Data != "" {
				if inTextBlock || currentToolID != "" {
					if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
						return err
					}
					contentIndex++
					inTextBlock = false
					currentToolID = ""
				}
				if err := sendEvent(ctx, events, types.LlmStreamEvent{
					Type:       "content_block_start",
					BlockIndex: contentIndex,
					ContentBlock: &types.LlmStreamContentBlock{
						Type:           "image",
						ImageData:      part.InlineData.Data,
						ImageMediaType: part.InlineData.MimeType,
					},
				}); err != nil {
					return err
				}
				if err := sendEvent(ctx, events, types.LlmStreamEvent{Type: "content_block_stop", BlockIndex: contentIndex}); err != nil {
					return err
				}
				contentIndex++
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

	if err := sseErr(); err != nil {
		if pe := ClassifyTransportError(err); pe != nil {
			return pe
		}
		return classifyGeminiError(0, err.Error())
	}

	return sendEvent(ctx, events, types.LlmStreamEvent{Type: "message_stop"})
}

func (p *googleProvider) buildRequestBody(opts types.LlmStreamOptions) map[string]any {
	// generationConfig is always present (it also carries thinkingConfig below),
	// but maxOutputTokens is optional on the Gemini API: when the engine has no
	// per-model value (and the caller set no override), omit the key so the
	// provider applies the model's own maximum rather than an engine-imposed cap.
	generationConfig := map[string]any{}
	if maxTokens, ok := resolveMaxOutputTokens(opts); ok {
		generationConfig["maxOutputTokens"] = maxTokens
	}

	body := map[string]any{
		"contents":         formatGeminiMessages(opts.Messages),
		"generationConfig": generationConfig,
	}

	// Gemini thinking — resolve the per-model mechanism via the shared
	// capability resolver. Gemini 2.5 models take a thinkingConfig with a
	// budget mapped from the effort level; includeThoughts requests thought
	// summaries so the thinking renderer has content to show. Only models
	// declared with ThinkingMode=="gemini" produce a directive.
	if res := resolveThinking(opts.Model, opts.Thinking); res.Mode == "gemini" {
		if gc, ok := body["generationConfig"].(map[string]any); ok {
			gc["thinkingConfig"] = map[string]any{
				"includeThoughts": true,
				"thinkingBudget":  res.Budget,
			}
		}
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
			case "compact_boundary":
				// Engine-internal compaction marker; Gemini must never see
				// the raw block type. Flatten to text so the model still sees
				// the rendered summary. See anthropic.go for rationale.
				text := b.Summary
				if text == "" {
					text = "[Previous conversation compacted]"
				}
				parts = append(parts, map[string]any{"text": text})
			case "context_injection":
				// Engine-internal nested-context marker; flatten to text so
				// the model still sees the descended instruction files. See
				// anthropic.go for rationale.
				text := b.Text
				if text == "" {
					text = "[Nested context loaded]"
				}
				parts = append(parts, map[string]any{"text": text})
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
	// InlineData carries a provider-generated image (Gemini image output).
	// MimeType is the MIME type (e.g. "image/png"); Data is base64 bytes.
	// Absent for text/function-call parts.
	InlineData *geminiInlineData `json:"inlineData,omitempty"`
}

// geminiInlineData is Gemini's inline binary payload (image output).
type geminiInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiFunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type geminiUsage struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
}
