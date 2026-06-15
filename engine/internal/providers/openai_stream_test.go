package providers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// sseServer spins up an httptest server that replays a fixed SSE body for the
// OpenAI chat-completions endpoint. The provider's baseURL is pointed at it so
// doStream runs against a real HTTP response without hitting a live provider.
func sseServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write SSE body: %v", err)
		}
	}))
}

// drainStream runs the provider stream to completion and returns the collected
// events plus the terminal error (nil on clean completion).
func drainStream(t *testing.T, p LlmProvider) ([]types.LlmStreamEvent, error) {
	t.Helper()
	evCh, errCh := p.Stream(context.Background(), types.LlmStreamOptions{Model: "test-model"})
	var collected []types.LlmStreamEvent
	for ev := range evCh {
		collected = append(collected, ev)
	}
	var streamErr error
	if errCh != nil {
		streamErr = <-errCh
	}
	return collected, streamErr
}

func newTestOpenAI(baseURL string) LlmProvider {
	return NewOpenAIProvider(&ProviderOptions{
		ID:      "openai-test",
		APIKey:  "test-key",
		BaseURL: baseURL,
	})
}

// TestOpenAIStreamDuplicateStopSingleStopPerBlock pins Defect 1 (layer 2): a
// trailing chunk carrying finish_reason after a tool-call turn must NOT cause
// a second content_block_stop for the same tool block. The provider resets its
// block state after emitting the stop, so exactly one stop is emitted.
func TestOpenAIStreamDuplicateStopSingleStopPerBlock(t *testing.T) {
	// Tool-call turn: id+name, then arg deltas, then a chunk carrying
	// finish_reason: "tool_calls" (the trailing chunk that historically
	// produced a second content_block_stop).
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"WebFetch","arguments":""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\"url\":\"https://x"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":".com\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}

	stops := 0
	for _, ev := range events {
		if ev.Type == "content_block_stop" {
			stops++
		}
	}
	if stops != 1 {
		t.Fatalf("content_block_stop count = %d, want exactly 1 (duplicate stop would clobber tool args)", stops)
	}

	// The accumulated tool args must have been streamed as input_json_delta.
	var partial strings.Builder
	for _, ev := range events {
		if ev.Type == "content_block_delta" && ev.Delta != nil && ev.Delta.Type == "input_json_delta" {
			partial.WriteString(ev.Delta.PartialJSON)
		}
	}
	if !strings.Contains(partial.String(), `"url"`) {
		t.Fatalf("streamed tool args missing url field: %q", partial.String())
	}
}

// TestOpenAIStreamErrorChunkReturnsProviderError pins Defect 2: a standalone
// {"error": {...}} chunk with empty choices must surface as a *ProviderError,
// not be swallowed by the empty-choices continue.
func TestOpenAIStreamErrorChunkReturnsProviderError(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[],"error":{"message":"upstream is overloaded","type":"server_error","code":"overloaded"}}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	_, err := drainStream(t, newTestOpenAI(srv.URL))
	if err == nil {
		t.Fatal("expected a *ProviderError, got nil (error chunk was swallowed)")
	}
	pe, ok := err.(*ProviderError)
	if !ok {
		t.Fatalf("error type = %T, want *ProviderError", err)
	}
	if !strings.Contains(pe.Message, "overloaded") {
		t.Errorf("error message = %q, want it to carry the provider message", pe.Message)
	}
	if !pe.Retryable {
		t.Errorf("overloaded in-stream error should be retryable")
	}
}

// TestOpenAIStreamFinishReasonError pins Defect 2: finish_reason: "error" must
// surface as a *ProviderError instead of being translated to a literal "error"
// stop reason that the run loop would treat as a successful empty turn.
func TestOpenAIStreamFinishReasonError(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"error"}],"error":{"message":"transient blip","type":"server_error"}}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err == nil {
		t.Fatal("expected a *ProviderError for finish_reason=error, got nil")
	}
	if _, ok := err.(*ProviderError); !ok {
		t.Fatalf("error type = %T, want *ProviderError", err)
	}
	// No "error" stop reason should have leaked into a message_delta.
	for _, ev := range events {
		if ev.Type == "message_delta" && ev.Delta != nil && ev.Delta.StopReason != nil && *ev.Delta.StopReason == "error" {
			t.Fatal("an 'error' stop reason leaked into a message_delta; it must be returned as a *ProviderError instead")
		}
	}
}

// TestOpenAIStreamFinishReasonErrorNoErrorObject pins the finish_reason branch
// specifically: a finish_reason: "error" with NO accompanying error object
// (the error lives only in the stop reason) must still surface as a
// *ProviderError — not a literal "error" stop reason. This exercises the
// finish_reason == "error" path independently of the chunk.Error path.
func TestOpenAIStreamFinishReasonErrorNoErrorObject(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"error"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err == nil {
		t.Fatal("expected a *ProviderError for a bare finish_reason=error, got nil")
	}
	pe, ok := err.(*ProviderError)
	if !ok {
		t.Fatalf("error type = %T, want *ProviderError", err)
	}
	// A bare error with no detail defaults to retryable so it is still surfaced.
	if !pe.Retryable {
		t.Errorf("bare finish_reason=error should default to retryable, got non-retryable")
	}
	for _, ev := range events {
		if ev.Type == "message_delta" && ev.Delta != nil && ev.Delta.StopReason != nil && *ev.Delta.StopReason == "error" {
			t.Fatal("an 'error' stop reason leaked into a message_delta")
		}
	}
}

// TestOpenAIStreamErrorClassification pins the precise retryability mechanism
// (not "retryable by default"): terminal in-stream error codes are
// non-retryable, while unknown ones default to retryable.
func TestOpenAIStreamErrorClassification(t *testing.T) {
	tests := []struct {
		name          string
		errorJSON     string
		wantCode      string
		wantRetryable bool
	}{
		{"invalid_model", `{"message":"the model does not exist","type":"invalid_request_error","code":"model_not_found"}`, ErrInvalidModel, false},
		{"content_filter", `{"message":"blocked by content policy","type":"content_filter","code":"content_filter"}`, ErrContentFilter, false},
		{"auth", `{"message":"invalid api key","type":"authentication_error","code":"invalid_api_key"}`, ErrAuth, false},
		{"rate_limit", `{"message":"rate limit exceeded","type":"rate_limit_error","code":"rate_limit_exceeded"}`, ErrRateLimit, true},
		{"unknown_default_retryable", `{"message":"something odd happened","type":"server_error","code":"weird"}`, ErrUnknown, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := fmt.Sprintf("data: {\"choices\":[],\"error\":%s}\n\ndata: [DONE]\n\n", tt.errorJSON)
			srv := sseServer(t, body)
			defer srv.Close()

			_, err := drainStream(t, newTestOpenAI(srv.URL))
			pe, ok := err.(*ProviderError)
			if !ok {
				t.Fatalf("error type = %T, want *ProviderError", err)
			}
			if pe.Code != tt.wantCode {
				t.Errorf("code = %q, want %q", pe.Code, tt.wantCode)
			}
			if pe.Retryable != tt.wantRetryable {
				t.Errorf("retryable = %v, want %v", pe.Retryable, tt.wantRetryable)
			}
		})
	}
}

// TestOpenAIStreamNumericErrorCode pins the json.RawMessage guard: a numeric
// error.code must not abort the whole-chunk unmarshal (which would silently
// swallow the error via the empty-choices continue).
func TestOpenAIStreamNumericErrorCode(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[],"error":{"message":"service unavailable","type":"server_error","code":503}}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	_, err := drainStream(t, newTestOpenAI(srv.URL))
	if err == nil {
		t.Fatal("expected a *ProviderError for a numeric-code error chunk, got nil (numeric code aborted chunk parsing)")
	}
	pe, ok := err.(*ProviderError)
	if !ok {
		t.Fatalf("error type = %T, want *ProviderError", err)
	}
	if !strings.Contains(pe.Message, "service unavailable") {
		t.Errorf("error message = %q, want it to carry the provider message", pe.Message)
	}
}

// TestOpenAIStreamWithRetryDiscardsPartialBuffer pins the Defect-2 assumption
// that WithRetry buffers events per attempt and discards them when the attempt
// ends in a *ProviderError. A consumer must never see the pre-error
// content_block_delta text from a failed attempt. Uses a non-retryable error
// so the run terminates after one attempt with the buffer dropped.
func TestOpenAIStreamWithRetryDiscardsPartialBuffer(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"leaked partial text"},"finish_reason":null}]}`,
		`data: {"choices":[],"error":{"message":"the model does not exist","type":"invalid_request_error","code":"model_not_found"}}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	p := newTestOpenAI(srv.URL)
	evCh, errCh := WithRetry(context.Background(), p, types.LlmStreamOptions{Model: "test-model"}, &RetryConfig{MaxRetries: 1})

	var collected []types.LlmStreamEvent
	for ev := range evCh {
		collected = append(collected, ev)
	}
	var streamErr error
	if errCh != nil {
		streamErr = <-errCh
	}

	if streamErr == nil {
		t.Fatal("expected a non-retryable *ProviderError from WithRetry")
	}
	for _, ev := range collected {
		if ev.Type == "content_block_delta" && ev.Delta != nil && strings.Contains(ev.Delta.Text, "leaked partial text") {
			t.Fatal("WithRetry forwarded partial text from a failed attempt; the buffer must be discarded on error")
		}
	}
}

// TestOpenAIStreamCleanToolCallSucceeds is the happy-path companion: a normal
// tool-call turn with no trailing finish_reason oddity completes without error
// and emits exactly one stop.
func TestOpenAIStreamCleanToolCallSucceeds(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"WebFetch","arguments":"{\"url\":\"https://x.com\"}"}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	stops := 0
	for _, ev := range events {
		if ev.Type == "content_block_stop" {
			stops++
		}
	}
	if stops != 1 {
		t.Fatalf("content_block_stop count = %d, want 1", stops)
	}
}
