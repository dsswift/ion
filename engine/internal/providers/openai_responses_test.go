package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// responsesSSE writes one Responses API SSE event.
func responsesSSE(w http.ResponseWriter, eventType string, payload map[string]any) {
	payload["type"] = eventType
	raw, _ := json.Marshal(payload) //nolint:errcheck // test fixture
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, raw)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// TestOpenAIResponsesProviderStream verifies the full SSE translation: text
// deltas, reasoning deltas, tool calls, usage extraction, and stop reasons.
func TestOpenAIResponsesProviderStream(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("x-api-key")
		_ = json.NewDecoder(r.Body).Decode(&gotBody) //nolint:errcheck // test fixture

		w.Header().Set("Content-Type", "text/event-stream")
		responsesSSE(w, "response.created", map[string]any{})
		responsesSSE(w, "response.reasoning_summary_text.delta", map[string]any{"delta": "thinking about it"})
		responsesSSE(w, "response.output_text.delta", map[string]any{"delta": "Hello"})
		responsesSSE(w, "response.output_text.delta", map[string]any{"delta": " world"})
		responsesSSE(w, "response.output_item.added", map[string]any{
			"item": map[string]any{"type": "function_call", "call_id": "call_123", "name": "get_weather"},
		})
		responsesSSE(w, "response.function_call_arguments.delta", map[string]any{"delta": `{"city":`})
		responsesSSE(w, "response.function_call_arguments.delta", map[string]any{"delta": `"SF"}`})
		responsesSSE(w, "response.output_item.done", map[string]any{})
		responsesSSE(w, "response.completed", map[string]any{
			"response": map[string]any{
				"usage": map[string]any{"input_tokens": 42, "output_tokens": 17},
			},
		})
	}))
	defer srv.Close()

	p := NewOpenAIResponsesProvider(&ProviderOptions{
		APIKey:     "test-key",
		BaseURL:    srv.URL,
		AuthHeader: "x-api-key",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	events, errc := p.Stream(ctx, types.LlmStreamOptions{
		Model:  "gpt-5.2-codex",
		System: "be helpful",
		Messages: []types.LlmMessage{
			{Role: "user", Content: "hi"},
		},
	})

	var (
		text        string
		thinking    string
		toolName    string
		toolArgs    string
		stopReason  string
		inputToks   int
		outputToks  int
		sawStart    bool
		sawStop     bool
		toolBlockID string
	)
	for ev := range events {
		switch ev.Type {
		case "message_start":
			sawStart = true
		case "content_block_start":
			if ev.ContentBlock != nil && ev.ContentBlock.Type == "tool_use" {
				toolName = ev.ContentBlock.Name
				toolBlockID = ev.ContentBlock.ID
			}
		case "content_block_delta":
			if ev.Delta != nil {
				switch ev.Delta.Type {
				case "text_delta":
					text += ev.Delta.Text
				case "thinking_delta":
					thinking += ev.Delta.Thinking
				case "input_json_delta":
					toolArgs += ev.Delta.PartialJSON
				}
			}
		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != nil {
				stopReason = *ev.Delta.StopReason
			}
			if ev.DeltaUsage != nil {
				inputToks = ev.DeltaUsage.InputTokens
				outputToks = ev.DeltaUsage.OutputTokens
			}
		case "message_stop":
			sawStop = true
		}
	}
	if err := <-errc; err != nil {
		t.Fatalf("stream error: %v", err)
	}

	if gotPath != "/v1/responses" {
		t.Errorf("path = %q, want /v1/responses", gotPath)
	}
	if gotAuth != "test-key" {
		t.Errorf("x-api-key = %q, want test-key", gotAuth)
	}
	if gotBody["instructions"] != "be helpful" {
		t.Errorf("instructions = %v, want 'be helpful'", gotBody["instructions"])
	}
	if gotBody["store"] != false {
		t.Errorf("store = %v, want false", gotBody["store"])
	}
	if !sawStart || !sawStop {
		t.Errorf("missing lifecycle events: start=%v stop=%v", sawStart, sawStop)
	}
	if text != "Hello world" {
		t.Errorf("text = %q, want 'Hello world'", text)
	}
	if thinking != "thinking about it" {
		t.Errorf("thinking = %q", thinking)
	}
	if toolName != "get_weather" || toolBlockID != "call_123" {
		t.Errorf("tool = %q/%q, want get_weather/call_123", toolName, toolBlockID)
	}
	if toolArgs != `{"city":"SF"}` {
		t.Errorf("toolArgs = %q", toolArgs)
	}
	if stopReason != "tool_use" {
		t.Errorf("stopReason = %q, want tool_use (tool call present)", stopReason)
	}
	if inputToks != 42 || outputToks != 17 {
		t.Errorf("usage = %d/%d, want 42/17", inputToks, outputToks)
	}
}

// TestOpenAIResponsesProviderError verifies HTTP error translation.
func TestOpenAIResponsesProviderError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"error":{"message":"rate limited","code":"rate_limit_exceeded"}}`)
	}))
	defer srv.Close()

	p := NewOpenAIResponsesProvider(&ProviderOptions{APIKey: "k", BaseURL: srv.URL})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	events, errc := p.Stream(ctx, types.LlmStreamOptions{
		Model:    "gpt-5.3-codex",
		Messages: []types.LlmMessage{{Role: "user", Content: "hi"}},
	})
	for range events { //nolint:revive // drain
	}
	err := <-errc
	if err == nil {
		t.Fatal("expected error from 429 response")
	}
	var pe *ProviderError
	if !errors.As(err, &pe) {
		t.Fatalf("expected *ProviderError, got %T: %v", err, err)
	}
}

// TestFormatResponsesInput verifies canonical-to-Responses input translation.
func TestFormatResponsesInput(t *testing.T) {
	items := formatResponsesInput([]types.LlmMessage{
		{Role: "user", Content: "question"},
		{Role: "assistant", Content: []types.LlmContentBlock{
			{Type: "text", Text: "let me check"},
			{Type: "tool_use", ID: "call_1", Name: "lookup", Input: map[string]any{"q": "x"}},
		}},
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "call_1", Content: "result data"},
		}},
	})

	if len(items) != 4 {
		t.Fatalf("items = %d, want 4 (user msg, assistant msg, function_call, function_call_output)", len(items))
	}
	if items[0]["type"] != "message" || items[0]["role"] != "user" {
		t.Errorf("item 0 = %v", items[0])
	}
	if items[1]["type"] != "message" || items[1]["role"] != "assistant" {
		t.Errorf("item 1 = %v", items[1])
	}
	if items[2]["type"] != "function_call" || items[2]["call_id"] != "call_1" || items[2]["name"] != "lookup" {
		t.Errorf("item 2 = %v", items[2])
	}
	if items[3]["type"] != "function_call_output" || items[3]["call_id"] != "call_1" || items[3]["output"] != "result data" {
		t.Errorf("item 3 = %v", items[3])
	}
}
