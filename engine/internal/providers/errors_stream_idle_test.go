package providers

import (
	"errors"
	"fmt"
	"testing"
)

// errors_stream_idle_test.go — regression tests for the stream-idle retry
// downgrade (the 1784411116509-07b16188baa6 / 1784462328153-ba5e921c0eba
// incident).
//
// streamWithIdle reports a RETRYABLE *ProviderError (stream_truncated, tagged
// stream_idle) when the upstream stalls mid-stream. The provider sseErr()
// handlers route that error through ClassifyTransportError and then, on nil,
// through From*Error(..., 0, "") — which used to rewrap it as
// ErrUnknown/Retryable:false, so WithRetry treated a designed-retryable stall
// as terminal and the run died with engine_dead instead of re-streaming.
//
// The fix: ClassifyTransportError is idempotent — an error that already is
// (or wraps) a *ProviderError is returned as-is. These tests pin that at both
// layers. Each fails on the unfixed code: the idle error message ("stream_idle:
// no SSE event for 1m30s (idle deadline 1m30s) — upstream stalled mid-stream")
// matches none of the transport string patterns, so the unfixed classifier
// returns nil and the From*Error fallback downgrades to non-retryable.

// idleProviderError builds the exact error shape streamWithIdle produces on
// an idle-deadline fire (sse_idle.go).
func idleProviderError() *ProviderError {
	return &ProviderError{
		Code:      ErrStreamTruncated,
		Message:   "stream_idle: no SSE event for 1m30.002s (idle deadline 1m30s) — upstream stalled mid-stream",
		Retryable: true,
	}
}

// TestClassifyTransportError_PreservesProviderError pins the idempotency
// guard: a *ProviderError passed directly (the anthropic/openai/google/
// bedrock sseErr() call shape — errFn returns the idle error unwrapped) must
// come back as-is with Retryable intact, not nil.
func TestClassifyTransportError_PreservesProviderError(t *testing.T) {
	src := idleProviderError()
	got := ClassifyTransportError(src)
	if got == nil {
		t.Fatal("ClassifyTransportError returned nil for an already-classified *ProviderError — the sseErr() site will downgrade it to ErrUnknown/Retryable:false")
	}
	if got != src {
		t.Fatalf("expected the original *ProviderError returned as-is, got a new value: %+v", got)
	}
	if !got.Retryable {
		t.Fatal("Retryable flag lost in classification")
	}
	if got.Code != ErrStreamTruncated {
		t.Fatalf("Code changed: want %q got %q", ErrStreamTruncated, got.Code)
	}
}

// TestClassifyTransportError_UnwrapsWrappedProviderError pins the wrapped
// shape: FromAnthropicError receives fmt.Errorf("sse read: %w", idleErr), so
// the classifier must find the *ProviderError through the wrap chain.
func TestClassifyTransportError_UnwrapsWrappedProviderError(t *testing.T) {
	src := idleProviderError()
	wrapped := fmt.Errorf("sse read: %w", src)
	got := ClassifyTransportError(wrapped)
	if got == nil {
		t.Fatal("ClassifyTransportError returned nil for a wrapped *ProviderError")
	}
	if got != src {
		t.Fatalf("expected the wrapped *ProviderError unwrapped and returned, got: %+v", got)
	}
	if !got.Retryable {
		t.Fatal("Retryable flag lost through the wrap chain")
	}
}

// TestFromAnthropicError_PreservesRetryableIdleError replays the exact
// anthropic.go sseErr() fallback path from the incident:
// FromAnthropicError(fmt.Errorf("sse read: %w", idleErr), 0, "").
// On the unfixed code this produced ErrUnknown/Retryable:false (the log
// fingerprint "unknown: sse read: stream_truncated: stream_idle: ...");
// fixed, the original retryable classification survives.
func TestFromAnthropicError_PreservesRetryableIdleError(t *testing.T) {
	src := idleProviderError()
	got := FromAnthropicError(fmt.Errorf("sse read: %w", src), 0, "")
	if got.Code == ErrUnknown {
		t.Fatalf("idle error downgraded to ErrUnknown — WithRetry will treat a designed-retryable stall as terminal: %+v", got)
	}
	if !got.Retryable {
		t.Fatalf("idle error lost Retryable through FromAnthropicError: %+v", got)
	}
	if got.Code != ErrStreamTruncated {
		t.Fatalf("Code changed: want %q got %q", ErrStreamTruncated, got.Code)
	}
}

// TestFromOpenAIError_PreservesRetryableIdleError — same replay for the
// openai.go sseErr() fallback (openai, plus the OpenAI-compatible factory
// providers: groq, cerebras, mistral, openrouter, together, fireworks, xai,
// deepseek, ollama all route through FromOpenAIError).
func TestFromOpenAIError_PreservesRetryableIdleError(t *testing.T) {
	src := idleProviderError()
	got := FromOpenAIError(fmt.Errorf("sse read: %w", src), 0, "")
	if got.Code == ErrUnknown {
		t.Fatalf("idle error downgraded to ErrUnknown: %+v", got)
	}
	if !got.Retryable {
		t.Fatalf("idle error lost Retryable through FromOpenAIError: %+v", got)
	}
}

// TestClassifyTransportError_NilAndPlainErrors pins that the idempotency
// guard does not change behavior for the existing cases: nil stays nil,
// unrecognized plain errors stay nil, and recognized transport strings still
// classify.
func TestClassifyTransportError_NilAndPlainErrors(t *testing.T) {
	if got := ClassifyTransportError(nil); got != nil {
		t.Fatalf("nil error must classify to nil, got %+v", got)
	}
	if got := ClassifyTransportError(errors.New("some application error")); got != nil {
		t.Fatalf("unrecognized error must classify to nil, got %+v", got)
	}
	got := ClassifyTransportError(errors.New("read tcp: connection reset by peer"))
	if got == nil || got.Code != ErrStaleConn || !got.Retryable {
		t.Fatalf("transport string classification regressed: %+v", got)
	}
}
