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

// TestOpenAIStreamWithRetryForwardsPartialThenError pins the live-forwarding
// contract at the OpenAI provider boundary: WithRetry forwards events as they
// arrive, so a stream that dies mid-attempt with a NON-retryable error still
// delivers the pre-error partial events, followed by the *ProviderError on the
// error channel. Discarding partial state is the CALLER's job — on a terminal
// error the backend run loop aborts the turn without persisting the partial
// blocks (and on a retryable failure WithRetry injects a stream_reset marker;
// see retry_test.go). The pre-live-forwarding behavior (buffer per attempt,
// drop on error) is gone by design: it delayed every healthy stream's output
// until completion, which read as a hung conversation on long turns.
func TestOpenAIStreamWithRetryForwardsPartialThenError(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"partial text before failure"},"finish_reason":null}]}`,
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
	sawPartial := false
	for _, ev := range collected {
		if ev.Type == "content_block_delta" && ev.Delta != nil && strings.Contains(ev.Delta.Text, "partial text before failure") {
			sawPartial = true
		}
		if ev.Type == types.LlmStreamEventStreamReset {
			t.Fatal("stream_reset marker emitted for a NON-retryable error; the marker is reserved for retried attempts")
		}
	}
	if !sawPartial {
		t.Fatal("pre-error partial event was not forwarded live to the caller")
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

// findImageBlock returns the first content_block_start image block in the
// collected events, or nil if none was emitted.
func findImageBlock(events []types.LlmStreamEvent) *types.LlmStreamContentBlock {
	for _, ev := range events {
		if ev.Type == "content_block_start" && ev.ContentBlock != nil && ev.ContentBlock.Type == "image" {
			return ev.ContentBlock
		}
	}
	return nil
}

// TestOpenAIStreamImageDataURL pins provider image-output parsing for the
// data-URL shape: a delta carrying images:[{image_url:{url:"data:image/png;
// base64,..."}}] must emit an image content block carrying the decoded media
// type + base64 payload. Without the openaiDelta.Images parsing this block is
// never emitted and the assertion fails.
func TestOpenAIStreamImageDataURL(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAECAwQ="}}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	img := findImageBlock(events)
	if img == nil {
		t.Fatal("no image content block emitted; provider dropped the image output")
	}
	if img.ImageMediaType != "image/png" {
		t.Errorf("media type = %q, want image/png", img.ImageMediaType)
	}
	if img.ImageData != "AAECAwQ=" {
		t.Errorf("image data = %q, want the base64 payload from the data URL", img.ImageData)
	}
}

// TestOpenAIStreamImageB64JSON pins the b64_json shape: images:[{b64_json:...,
// media_type:...}] must emit an image content block with the explicit media
// type. Also verifies the image block is self-contained (its own start+stop).
func TestOpenAIStreamImageB64JSON(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"images":[{"type":"image","b64_json":"Zm9vYmFy","media_type":"image/jpeg"}]}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	img := findImageBlock(events)
	if img == nil {
		t.Fatal("no image content block emitted for b64_json image output")
	}
	if img.ImageMediaType != "image/jpeg" {
		t.Errorf("media type = %q, want image/jpeg", img.ImageMediaType)
	}
	if img.ImageData != "Zm9vYmFy" {
		t.Errorf("image data = %q, want the b64_json payload", img.ImageData)
	}
}

// TestParseOpenAIImageOut unit-tests the shape normalizer directly, covering
// the data-URL, b64_json, and malformed cases.
func TestParseOpenAIImageOut(t *testing.T) {
	// b64_json with explicit media type
	mt, data := parseOpenAIImageOut(openaiImageOut{B64JSON: "QQ==", MediaType: "image/webp"})
	if mt != "image/webp" || data != "QQ==" {
		t.Errorf("b64_json: got (%q,%q), want (image/webp,QQ==)", mt, data)
	}
	// b64_json without media type defaults to png
	mt, _ = parseOpenAIImageOut(openaiImageOut{B64JSON: "QQ=="})
	if mt != "image/png" {
		t.Errorf("b64_json default media type = %q, want image/png", mt)
	}
	// data URL
	mt, data = parseOpenAIImageOut(openaiImageOut{ImageURL: &struct {
		URL string `json:"url"`
	}{URL: "data:image/gif;base64,R0lGOD"}})
	if mt != "image/gif" || data != "R0lGOD" {
		t.Errorf("data URL: got (%q,%q), want (image/gif,R0lGOD)", mt, data)
	}
	// malformed / empty
	if mt, data := parseOpenAIImageOut(openaiImageOut{}); mt != "" || data != "" {
		t.Errorf("empty entry: got (%q,%q), want empty", mt, data)
	}
}
