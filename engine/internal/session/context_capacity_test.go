package session

import (
	"context"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

type nativeCapacityMockBackend struct{ *mockBackend }

func (m *nativeCapacityMockBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{Kind: "native-test", ContextModel: backend.ContextModelNativeSession}
}

type capacityRecoveryProvider struct {
	mu       sync.Mutex
	requests []types.LlmStreamOptions
}

func (*capacityRecoveryProvider) ID() string { return "capacity-recovery-provider" }

func (*capacityRecoveryProvider) CountTokens(context.Context, providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *capacityRecoveryProvider) Stream(_ context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	p.mu.Lock()
	p.requests = append(p.requests, opts)
	p.mu.Unlock()
	events := make(chan types.LlmStreamEvent, 5)
	errc := make(chan error)
	stopReason := "end_turn"
	events <- types.LlmStreamEvent{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "capacity-recovery", Model: opts.Model, Usage: types.LlmUsage{InputTokens: 1_000}}}
	events <- types.LlmStreamEvent{Type: "content_block_start", BlockIndex: 0, ContentBlock: &types.LlmStreamContentBlock{Type: "text"}}
	events <- types.LlmStreamEvent{Type: "content_block_delta", BlockIndex: 0, Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "continued"}}
	events <- types.LlmStreamEvent{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}, DeltaUsage: &types.LlmUsage{OutputTokens: 5}}
	events <- types.LlmStreamEvent{Type: "message_stop"}
	close(events)
	close(errc)
	return events, errc
}

func (p *capacityRecoveryProvider) requestSnapshot() []types.LlmStreamOptions {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]types.LlmStreamOptions(nil), p.requests...)
}

func TestSendPrompt_ContextCapacityRecoversEndToEnd(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const model = "capacity-engine-owned-e2e"
	provider := &capacityRecoveryProvider{}
	providers.RegisterProvider(provider)
	providers.RegisterModel(model, types.ModelInfo{ProviderID: provider.ID(), ContextWindow: 100_000, MaxOutputTokens: 10_000})
	t.Cleanup(func() {
		providers.UnregisterModel(model)
		providers.UnregisterProvider(provider.ID())
	})

	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()
	cfg := defaultConfig()
	cfg.Model = model
	_, _ = mgr.StartSession("full-e2e", cfg)

	mgr.mu.Lock()
	mgr.sessions["full-e2e"].conversationID = "capacity-full-e2e"
	convID := mgr.sessions["full-e2e"].conversationID
	mgr.mu.Unlock()
	conv := conversation.CreateConversation(convID, "", model)
	for i := 0; i < 4; i++ {
		conversation.AddUserMessage(conv, "prior user turn")
		usage := types.LlmUsage{}
		if i == 3 {
			usage.InputTokens = 77_000
		}
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "prior assistant turn"}}, usage)
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}

	if err := mgr.SendPrompt("full-e2e", "resume", &PromptOverrides{Model: model, CompactSummaryEnabled: boolRef(false)}); err != nil {
		t.Fatalf("SendPrompt blocked recoverable conversation: %v", err)
	}
	if !waitForCount(func() int { return len(provider.requestSnapshot()) }, 1) {
		t.Fatal("provider did not receive the resumed request")
	}
	requests := provider.requestSnapshot()
	if len(requests) != 1 {
		t.Fatalf("provider request count = %d, want 1", len(requests))
	}
	var sawBoundary bool
	for _, message := range requests[0].Messages {
		if conversation.IsCompactBoundary(message) {
			sawBoundary = true
			break
		}
	}
	if !sawBoundary {
		t.Fatal("resumed provider request did not contain an auto-compaction boundary")
	}
	if !waitForCount(func() int {
		mgr.mu.Lock()
		defer mgr.mu.Unlock()
		if mgr.sessions["full-e2e"].requestID == "" {
			return 1
		}
		return 0
	}, 1) {
		t.Fatal("resumed run did not finish")
	}
}

func boolRef(value bool) *bool { return &value }

func TestSendPrompt_ContextCapacityAllowsEngineOwnedAutoCompactionRecovery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const model = "capacity-engine-owned-recovery"
	providers.RegisterModel(model, types.ModelInfo{ProviderID: "openai", ContextWindow: 100_000, MaxOutputTokens: 10_000})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	cfg := defaultConfig()
	cfg.Model = model
	_, _ = mgr.StartSession("full", cfg)

	mgr.mu.Lock()
	mgr.sessions["full"].conversationID = "capacity-full-recovery"
	convID := mgr.sessions["full"].conversationID
	mgr.mu.Unlock()
	conv := conversation.CreateConversation(convID, "", model)
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "prior"}}, types.LlmUsage{InputTokens: 77_000})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}

	if err := mgr.SendPrompt("full", "resume", &PromptOverrides{Model: model}); err != nil {
		t.Fatalf("SendPrompt blocked recoverable conversation: %v", err)
	}
	if got := len(mb.startedKeys()); got != 1 {
		t.Fatalf("backend StartRun count = %d, want 1", got)
	}
	if errs := ec.byType("engine_error"); len(errs) != 0 {
		t.Fatalf("engine_error count = %d, want 0", len(errs))
	}
}

func TestSendPrompt_ContextCapacityBlocksWhenAutoCompactionDisabled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const model = "capacity-engine-owned-disabled"
	providers.RegisterModel(model, types.ModelInfo{ProviderID: "openai", ContextWindow: 100_000, MaxOutputTokens: 10_000})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	cfg := defaultConfig()
	cfg.Model = model
	_, _ = mgr.StartSession("full-disabled", cfg)

	mgr.mu.Lock()
	mgr.sessions["full-disabled"].conversationID = "capacity-full-disabled"
	convID := mgr.sessions["full-disabled"].conversationID
	mgr.mu.Unlock()
	conv := conversation.CreateConversation(convID, "", model)
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "prior"}}, types.LlmUsage{InputTokens: 77_000})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}

	disabled := false
	if err := mgr.SendPrompt("full-disabled", "blocked", &PromptOverrides{Model: model, CompactEnabled: &disabled}); err == nil {
		t.Fatal("SendPrompt succeeded while auto-compaction was disabled")
	}
	if got := len(mb.startedKeys()); got != 0 {
		t.Fatalf("backend StartRun count = %d, want 0", got)
	}
	errs := ec.byType("engine_error")
	if len(errs) != 1 {
		t.Fatalf("engine_error count = %d, want 1", len(errs))
	}
	ev := errs[0].event
	if ev.ErrorCode != "context_limit_reached" || ev.ContextTokens < 77_000 || ev.ContextLimit != 77_000 || ev.ContextWindow != 100_000 {
		t.Errorf("capacity error = %+v, want stable code and structured counts", ev)
	}
	mgr.mu.Lock()
	requestID := mgr.sessions["full-disabled"].requestID
	mgr.mu.Unlock()
	if requestID != "" {
		t.Errorf("requestID = %q, want cleanup after refusal", requestID)
	}
}

func TestSendPrompt_ContextCapacityDoesNotBlockNativeSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const model = "capacity-native"
	providers.RegisterModel(model, types.ModelInfo{ProviderID: "openai", ContextWindow: 100_000, MaxOutputTokens: 10_000})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	mb := &nativeCapacityMockBackend{newMockBackend()}
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.Model = model
	_, _ = mgr.StartSession("native", cfg)

	mgr.mu.Lock()
	mgr.sessions["native"].conversationID = "capacity-native"
	convID := mgr.sessions["native"].conversationID
	mgr.mu.Unlock()
	conv := conversation.CreateConversation(convID, "", model)
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "prior"}}, types.LlmUsage{InputTokens: 77_000, CacheCreationInputTokens: 1})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}

	if err := mgr.SendPrompt("native", "allowed", &PromptOverrides{Model: model}); err != nil {
		t.Fatalf("native session was blocked: %v", err)
	}
	if got := len(mb.startedKeys()); got != 1 {
		t.Fatalf("backend StartRun count = %d, want 1", got)
	}
}
