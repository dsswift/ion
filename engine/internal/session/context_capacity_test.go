package session

import (
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

func TestSendPrompt_ContextCapacityBlocksEngineOwnedBeforeBackendStart(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const model = "capacity-engine-owned"
	providers.RegisterModel(model, types.ModelInfo{ProviderID: "openai", ContextWindow: 100_000, MaxOutputTokens: 10_000})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)
	cfg := defaultConfig()
	cfg.Model = model
	_, _ = mgr.StartSession("full", cfg)

	mgr.mu.Lock()
	mgr.sessions["full"].conversationID = "capacity-full"
	convID := mgr.sessions["full"].conversationID
	mgr.mu.Unlock()
	conv := conversation.CreateConversation(convID, "", model)
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "prior"}}, types.LlmUsage{InputTokens: 77_000, CacheCreationInputTokens: 1})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}

	if err := mgr.SendPrompt("full", "blocked", &PromptOverrides{Model: model}); err == nil {
		t.Fatal("SendPrompt succeeded at the effective context limit")
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
	requestID := mgr.sessions["full"].requestID
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
