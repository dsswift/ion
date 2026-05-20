package providers

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

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
