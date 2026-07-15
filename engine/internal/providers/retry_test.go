package providers

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// recvEvent reads one event from ch with a deadline so a regression to
// buffered (non-live) forwarding fails the test instead of hanging it.
func recvEvent(t *testing.T, ch <-chan types.LlmStreamEvent) types.LlmStreamEvent {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("event channel closed while an event was expected")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for stream event (events are not forwarded live)")
		return types.LlmStreamEvent{}
	}
}

// gatedProvider emits one event, then blocks until the test closes gate, then
// emits a second event and completes cleanly. Used to prove events reach the
// WithRetry caller BEFORE the provider stream finishes.
type gatedProvider struct {
	gate chan struct{}
}

func (g *gatedProvider) ID() string { return "gated-prov" }

func (g *gatedProvider) CountTokens(_ context.Context, _ CountTokensRequest) (int, error) {
	return 0, ErrCountUnsupported
}

func (g *gatedProvider) Stream(ctx context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent)
	errc := make(chan error, 1)
	go func() {
		defer close(events)
		defer close(errc)
		events <- types.LlmStreamEvent{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m1", Model: "gated"}}
		select {
		case <-g.gate:
		case <-ctx.Done():
			errc <- ctx.Err()
			return
		}
		events <- types.LlmStreamEvent{Type: "message_stop"}
	}()
	return events, errc
}

// midStreamFailProvider emits eventsBeforeFail then fails with failErr for the
// first failCount calls; afterwards it emits successEvents and completes
// cleanly. Models a provider stream that dies AFTER partial output went out.
type midStreamFailProvider struct {
	id               string
	failCount        int
	failErr          *ProviderError
	eventsBeforeFail []types.LlmStreamEvent
	successEvents    []types.LlmStreamEvent
	callCount        int
}

func (m *midStreamFailProvider) ID() string { return m.id }

func (m *midStreamFailProvider) CountTokens(_ context.Context, _ CountTokensRequest) (int, error) {
	return 0, ErrCountUnsupported
}

func (m *midStreamFailProvider) Stream(ctx context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 16)
	errc := make(chan error, 1)
	go func() {
		defer close(events)
		defer close(errc)
		m.callCount++
		if m.callCount <= m.failCount {
			for _, ev := range m.eventsBeforeFail {
				select {
				case events <- ev:
				case <-ctx.Done():
					errc <- ctx.Err()
					return
				}
			}
			errc <- m.failErr
			return
		}
		for _, ev := range m.successEvents {
			select {
			case events <- ev:
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			}
		}
	}()
	return events, errc
}

// TestWithRetryForwardsEventsLive pins the live-streaming contract: an event
// must reach the WithRetry caller while the provider stream is still open.
// Reverting to per-attempt buffering (flush-on-completion) deadlocks this
// sequence — the first recvEvent would wait on a flush that never happens
// until the gate opens — and the recv deadline turns that into a failure.
func TestWithRetryForwardsEventsLive(t *testing.T) {
	gate := make(chan struct{})
	provider := &gatedProvider{gate: gate}

	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "gated-model"}, &RetryConfig{})

	// First event must arrive while the provider is still blocked on gate.
	first := recvEvent(t, events)
	if first.Type != "message_start" {
		t.Fatalf("first event = %q, want message_start", first.Type)
	}

	// Unblock the provider; the rest of the stream follows.
	close(gate)
	second := recvEvent(t, events)
	if second.Type != "message_stop" {
		t.Fatalf("second event = %q, want message_stop", second.Type)
	}
	if _, ok := <-events; ok {
		t.Fatal("expected event channel to close after clean completion")
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestWithRetryMidStreamFailureEmitsResetMarker pins the retry-safety half of
// live forwarding: when a retryable failure interrupts a stream that already
// forwarded events, the caller must receive a stream_reset marker before the
// next attempt's events, so it can discard the partial state.
func TestWithRetryMidStreamFailureEmitsResetMarker(t *testing.T) {
	provider := &midStreamFailProvider{
		id:        "midfail-prov",
		failCount: 1,
		failErr:   NewProviderError(ErrStreamTruncated, "stream died mid-flight", 0, true),
		eventsBeforeFail: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m_dead", Model: "midfail"}},
			{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "partial"}},
		},
		successEvents: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m_ok", Model: "midfail"}},
			{Type: "message_stop"},
		},
	}
	config := &RetryConfig{MaxRetries: 3, BaseDelayMs: 1, MaxDelayMs: 1}

	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "midfail-model"}, config)
	var collected []string
	for ev := range events {
		collected = append(collected, ev.Type)
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{"message_start", "content_block_delta", types.LlmStreamEventStreamReset, "message_start", "message_stop"}
	if len(collected) != len(want) {
		t.Fatalf("event sequence = %v, want %v", collected, want)
	}
	for i := range want {
		if collected[i] != want[i] {
			t.Fatalf("event[%d] = %q, want %q (full sequence %v)", i, collected[i], want[i], collected)
		}
	}
}

// TestWithRetryNoResetWhenAttemptFailedBeforeEvents pins the inverse: an
// attempt that fails before forwarding anything must NOT inject a spurious
// reset marker — consumers have nothing to discard.
func TestWithRetryNoResetWhenAttemptFailedBeforeEvents(t *testing.T) {
	provider := &midStreamFailProvider{
		id:               "prefail-prov",
		failCount:        1,
		failErr:          NewProviderError(ErrStreamTruncated, "failed before first byte", 0, true),
		eventsBeforeFail: nil, // fails with zero events forwarded
		successEvents: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m_ok", Model: "prefail"}},
			{Type: "message_stop"},
		},
	}
	config := &RetryConfig{MaxRetries: 3, BaseDelayMs: 1, MaxDelayMs: 1}

	events, errc := WithRetry(context.Background(), provider, types.LlmStreamOptions{Model: "prefail-model"}, config)
	var collected []string
	for ev := range events {
		collected = append(collected, ev.Type)
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, typ := range collected {
		if typ == types.LlmStreamEventStreamReset {
			t.Fatalf("spurious stream_reset marker in %v (attempt failed before any events)", collected)
		}
	}
	if len(collected) != 2 {
		t.Fatalf("event count = %d, want 2: %v", len(collected), collected)
	}
}

// TestWithRetryFallbackHopEmitsResetMarker covers the second retry path (the
// fallback-chain hop): partial events from the overloaded primary must be
// reset before the fallback model's events arrive.
func TestWithRetryFallbackHopEmitsResetMarker(t *testing.T) {
	fb := &mockProvider{
		id: "resetfb-prov",
		events: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m_fb", Model: "resetfb-model"}},
			{Type: "message_stop"},
		},
	}
	RegisterProvider(fb)
	RegisterModel("resetfb-model", types.ModelInfo{ProviderID: "resetfb-prov"})
	defer func() {
		mu.Lock()
		delete(providerRegistry, "resetfb-prov")
		delete(modelRegistry, "resetfb-model")
		mu.Unlock()
	}()

	primary := &midStreamFailProvider{
		id:        "resetprimary-prov",
		failCount: 100,
		failErr:   NewProviderError(ErrOverloaded, "overloaded mid-stream", 529, true),
		eventsBeforeFail: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m_dead", Model: "primary"}},
		},
	}
	config := &RetryConfig{
		MaxRetries:                  10,
		BaseDelayMs:                 1,
		MaxDelayMs:                  1,
		FallbackChain:               []string{"resetfb-model"},
		MaxOverloadedBeforeFallback: 1,
	}

	events, errc := WithRetry(context.Background(), primary, types.LlmStreamOptions{Model: "primary-model"}, config)
	var collected []string
	for ev := range events {
		collected = append(collected, ev.Type)
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{"message_start", types.LlmStreamEventStreamReset, "message_start", "message_stop"}
	if len(collected) != len(want) {
		t.Fatalf("event sequence = %v, want %v", collected, want)
	}
	for i := range want {
		if collected[i] != want[i] {
			t.Fatalf("event[%d] = %q, want %q (full sequence %v)", i, collected[i], want[i], collected)
		}
	}
}

// TestRetryFallbackChainWalks covers the multi-hop chain: primary overloads,
// engine walks to fallback[0], that also overloads, engine walks to fallback[1],
// which succeeds. Each hop resets the overload counter so the next link gets
// its own budget. Without this, a chain of N would behave like a chain of 1.
func TestRetryFallbackChainWalks(t *testing.T) {
	fb1 := &mockProvider{
		id:        "fb1-prov",
		failCount: 2,
		failErr:   NewProviderError(ErrOverloaded, "overloaded fb1", 529, true),
		events: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "msg_fb1", Model: "fb1-model"}},
			{Type: "message_stop"},
		},
	}
	fb2 := &mockProvider{
		id: "fb2-prov",
		events: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "msg_fb2", Model: "fb2-model"}},
			{Type: "message_stop"},
		},
	}
	RegisterProvider(fb1)
	RegisterProvider(fb2)
	RegisterModel("fb1-model", types.ModelInfo{ProviderID: "fb1-prov"})
	RegisterModel("fb2-model", types.ModelInfo{ProviderID: "fb2-prov"})
	defer func() {
		mu.Lock()
		delete(providerRegistry, "fb1-prov")
		delete(providerRegistry, "fb2-prov")
		delete(modelRegistry, "fb1-model")
		delete(modelRegistry, "fb2-model")
		mu.Unlock()
	}()

	primary := &mockProvider{
		id:        "primary-prov",
		failCount: 100,
		failErr:   NewProviderError(ErrOverloaded, "overloaded primary", 529, true),
	}

	var hops []string
	config := &RetryConfig{
		MaxRetries:                  20,
		BaseDelayMs:                 1,
		MaxDelayMs:                  1,
		FallbackChain:               []string{"fb1-model", "fb2-model"},
		MaxOverloadedBeforeFallback: 2,
		OnFallback: func(from, to string, hop int) {
			hops = append(hops, from+"->"+to)
		},
	}

	events, errc := WithRetry(context.Background(), primary, types.LlmStreamOptions{Model: "primary-model"}, config)
	var collected []types.LlmStreamEvent
	for ev := range events {
		collected = append(collected, ev)
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if primary.callCount != 2 {
		t.Errorf("primary call count = %d, want 2", primary.callCount)
	}
	if fb1.callCount != 2 {
		t.Errorf("fb1 call count = %d, want 2", fb1.callCount)
	}
	if fb2.callCount != 1 {
		t.Errorf("fb2 call count = %d, want 1", fb2.callCount)
	}
	if len(hops) != 2 {
		t.Fatalf("expected 2 hops, got %d: %v", len(hops), hops)
	}
	if hops[0] != "primary-model->fb1-model" {
		t.Errorf("hop[0] = %q, want primary->fb1", hops[0])
	}
	if hops[1] != "fb1-model->fb2-model" {
		t.Errorf("hop[1] = %q, want fb1->fb2", hops[1])
	}
	if len(collected) != 2 {
		t.Errorf("expected 2 events from fb2, got %d", len(collected))
	}
}
