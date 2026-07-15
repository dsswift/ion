package backend

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestProviderTTFTTelemetry verifies a full run emits a provider.ttft event on
// the first stream event. Goes red if the emission is removed from processStream.
func TestProviderTTFTTelemetry(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("hi", 10, 5),
	})
	b := NewApiBackend()
	telem := &mockTelemetry{}
	c := collectEvents(b, "req-ttft")
	b.StartRunWithConfig("req-ttft", types.RunOptions{
		Prompt:           "ttft test",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Telemetry: telem})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	got := telem.eventsByName("provider.ttft")
	if len(got) < 1 {
		t.Fatalf("expected at least 1 provider.ttft event, got %d", len(got))
	}
	p := got[0].Payload
	if p["model"] != testModel {
		t.Errorf("model = %v, want %s", p["model"], testModel)
	}
	if _, ok := p["ttft_ms"].(int64); !ok {
		t.Errorf("ttft_ms missing/wrong type: %v", p["ttft_ms"])
	}
	if p["attempt"] != int64(0) {
		t.Errorf("attempt = %v, want 0 (un-retried stream reports attempt 0)", p["attempt"])
	}
	if p["provider"] != testProviderID {
		t.Errorf("provider = %v, want %s", p["provider"], testProviderID)
	}
}

// retryThenOkProvider returns a retryable ProviderError on its first Stream
// call, then a normal text response on subsequent calls. Drives the runloop's
// OnRetryWait closure through the real providers.WithRetry machinery.
type retryThenOkProvider struct {
	id    string
	calls int
}

func (p *retryThenOkProvider) ID() string { return p.id }

func (p *retryThenOkProvider) CountTokens(_ context.Context, _ providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *retryThenOkProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 8)
	errc := make(chan error, 1)
	p.calls++
	first := p.calls == 1
	go func() {
		defer close(events)
		defer close(errc)
		if first {
			errc <- &providers.ProviderError{
				Code:         "overloaded_error",
				Message:      "overloaded",
				Retryable:    true,
				RetryAfterMs: 1,
			}
			return
		}
		stopReason := "end_turn"
		events <- types.LlmStreamEvent{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m", Model: opts.Model, Usage: types.LlmUsage{InputTokens: 5}}}
		events <- types.LlmStreamEvent{Type: "message_delta", Delta: &types.LlmStreamDelta{StopReason: &stopReason}, DeltaUsage: &types.LlmUsage{OutputTokens: 2}}
		events <- types.LlmStreamEvent{Type: "message_stop"}
	}()
	return events, errc
}

// TestProviderRetryTelemetry drives a full run against a provider that fails
// retryably once, then succeeds. It pins the runloop's OnRetryWait closure
// emitting a provider.retry event. Goes red if that emission is removed.
func TestProviderRetryTelemetry(t *testing.T) {
	const retryModelID = "retry-telem-model"
	mock := &retryThenOkProvider{id: "retry-telem-provider"}
	providers.RegisterProvider(mock)
	providers.RegisterModel(retryModelID, types.ModelInfo{
		ProviderID:      mock.id,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	telem := &mockTelemetry{}
	c := collectEvents(b, "req-retry")
	b.StartRunWithConfig("req-retry", types.RunOptions{
		Prompt:           "retry test",
		ProjectPath:      "/tmp",
		Model:            retryModelID,
		MaxRetries:       3,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Telemetry: telem})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	got := telem.eventsByName("provider.retry")
	if len(got) < 1 {
		t.Fatalf("expected at least 1 provider.retry event, got %d", len(got))
	}
	p := got[0].Payload
	if p["model"] != retryModelID {
		t.Errorf("model = %v, want %s", p["model"], retryModelID)
	}
	if p["error_code"] != "overloaded_error" {
		t.Errorf("error_code = %v, want overloaded_error", p["error_code"])
	}
	if _, ok := p["attempt"].(int); !ok {
		t.Errorf("attempt missing/wrong type: %v", p["attempt"])
	}
	if _, ok := p["delay_ms"].(int); !ok {
		t.Errorf("delay_ms missing/wrong type: %v", p["delay_ms"])
	}
	if p["retry_after_ms"] != int64(1) {
		t.Errorf("retry_after_ms = %v, want 1", p["retry_after_ms"])
	}
}

// TestProviderTTFTAttemptThreadedFromRetry drives a full run against a provider
// that fails retryably once then succeeds, and pins that the provider.ttft
// event emitted for the SECOND (successful) stream carries attempt>0 — the real
// retry-attempt index threaded from OnRetryWait, not the hardcoded 0 the
// emission previously carried. Goes red on the pre-fix code (attempt == 0 even
// after a retry) because the ttft site no longer hardcodes the value; it reads
// run.currentAttempt, which OnRetryWait bumps to 1 before the retried stream.
func TestProviderTTFTAttemptThreadedFromRetry(t *testing.T) {
	const retryModelID = "ttft-retry-model"
	mock := &retryThenOkProvider{id: "ttft-retry-provider"}
	providers.RegisterProvider(mock)
	providers.RegisterModel(retryModelID, types.ModelInfo{
		ProviderID:      mock.id,
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	})

	b := NewApiBackend()
	telem := &mockTelemetry{}
	c := collectEvents(b, "req-ttft-retry")
	b.StartRunWithConfig("req-ttft-retry", types.RunOptions{
		Prompt:           "ttft retry test",
		ProjectPath:      "/tmp",
		Model:            retryModelID,
		MaxRetries:       3,
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{Telemetry: telem})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	got := telem.eventsByName("provider.ttft")
	if len(got) < 1 {
		t.Fatalf("expected at least 1 provider.ttft event, got %d", len(got))
	}
	// The ttft event fires on the first event of the stream the run consumes.
	// The first stream failed retryably, so the consumed stream is attempt 1.
	attempt, ok := got[0].Payload["attempt"].(int64)
	if !ok {
		t.Fatalf("attempt = %T, want int64", got[0].Payload["attempt"])
	}
	if attempt <= 0 {
		t.Errorf("attempt = %d, want > 0 (retried stream must report its real attempt index)", attempt)
	}
}

// TestProviderFallbackTelemetry verifies the no-provider-found fallback path in
// resolveProviderForRun emits a provider.fallback event.
func TestProviderFallbackTelemetry(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("ok", 1, 1),
	})
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}

	run := &activeRun{
		requestID: "fallback-req",
		cfg: &RunConfig{
			Telemetry:    telem,
			DefaultModel: testModel,
		},
	}
	opts := types.RunOptions{Model: "no-such-model-xyz", SessionKey: "sess-fb"}
	provider, model := b.resolveProviderForRun(run, &opts)
	if provider == nil {
		t.Fatal("expected fallback to resolve a provider")
	}
	if model != testModel {
		t.Errorf("model = %q, want %s (fallback)", model, testModel)
	}

	got := telem.eventsByName("provider.fallback")
	if len(got) != 1 {
		t.Fatalf("expected 1 provider.fallback event, got %d", len(got))
	}
	p := got[0].Payload
	if p["requested_model"] != "no-such-model-xyz" {
		t.Errorf("requested_model = %v", p["requested_model"])
	}
	if p["fallback_model"] != testModel {
		t.Errorf("fallback_model = %v, want %s", p["fallback_model"], testModel)
	}
	if p["reason"] != "no_provider_found" {
		t.Errorf("reason = %v, want no_provider_found", p["reason"])
	}
}
