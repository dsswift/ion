package extcontext

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// llmCallTestAccessor is a minimal SessionAccessor that records emitted
// events and exposes hooks to a test-supplied extension group. Only the
// surface that BuildLLMCallFunc actually exercises is wired; the rest of
// the methods are zero-value stubs so the test stays focused on the
// LLMCall code path.
type llmCallTestAccessor struct {
	mu       sync.Mutex
	emitted  []types.EngineEvent
	extGroup *extension.ExtensionGroup
}

func (a *llmCallTestAccessor) SessionKey() string       { return "test-session" }
func (a *llmCallTestAccessor) ConversationID() string   { return "" }
func (a *llmCallTestAccessor) WorkingDirectory() string { return "/tmp" }
func (a *llmCallTestAccessor) Emit(ev types.EngineEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.emitted = append(a.emitted, ev)
}
func (a *llmCallTestAccessor) Emitted() []types.EngineEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]types.EngineEvent, len(a.emitted))
	copy(out, a.emitted)
	return out
}
func (a *llmCallTestAccessor) SendAbort()                                                         {}
func (a *llmCallTestAccessor) SendPrompt(_, _ string) error                                       { return nil }
func (a *llmCallTestAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *llmCallTestAccessor) SuppressTool(_ string)                            {}
func (a *llmCallTestAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate)   {}
func (a *llmCallTestAccessor) RegisterAgent(_ string, _ types.AgentHandle)      {}
func (a *llmCallTestAccessor) DeregisterAgent(_ string)                         {}
func (a *llmCallTestAccessor) RegisterAgentSpec(_ types.AgentSpec)              {}
func (a *llmCallTestAccessor) DeregisterAgentSpec(_ string)                     {}
func (a *llmCallTestAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) { return types.AgentSpec{}, false }
func (a *llmCallTestAccessor) LookupExtDisplayName(_ string) string             { return "" }
func (a *llmCallTestAccessor) ExtGroup() *extension.ExtensionGroup              { return a.extGroup }
func (a *llmCallTestAccessor) ExtConfig() *extension.ExtensionConfig            { return nil }
func (a *llmCallTestAccessor) ProcRegistry() *extension.ProcessRegistry         { return nil }
func (a *llmCallTestAccessor) NewChildBackend() backend.RunBackend              { return nil }
func (a *llmCallTestAccessor) EngineConfig() *types.EngineRuntimeConfig         { return nil }
func (a *llmCallTestAccessor) ResolveTier(_ string) string                      { return "" }
func (a *llmCallTestAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *llmCallTestAccessor) McpConnections() []*mcp.Connection             { return nil }
func (a *llmCallTestAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (a *llmCallTestAccessor) GetSessionMemory() string                              { return "" }
func (a *llmCallTestAccessor) SetSessionMemory(_ string)                             {}
func (a *llmCallTestAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *llmCallTestAccessor) SetPlanMode(_ bool, _ string)        {}
func (a *llmCallTestAccessor) GetPlanModeState() (bool, string)    { return false, "" }
func (a *llmCallTestAccessor) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string { return "" }
func (a *llmCallTestAccessor) UpdateAgentStateByID(_ string, _ func(*types.AgentStateUpdate))  {}
func (a *llmCallTestAccessor) EmitAgentSnapshot(_ string) {}
func (a *llmCallTestAccessor) ResourceBroker() *resource.Broker       { return nil }
func (a *llmCallTestAccessor) GlobalResourceBroker() *resource.Broker { return nil }
func (a *llmCallTestAccessor) BroadcastNotification(_ types.NotifyOpts)        {}
func (a *llmCallTestAccessor) BroadcastIntercept(_ extension.InterceptOpts)    {}
func (a *llmCallTestAccessor) ListAllSessions() []extension.SessionListEntry { return nil }
func (a *llmCallTestAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}
func (a *llmCallTestAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (a *llmCallTestAccessor) RunOnceComplete(_ string, _ bool)              {}

// registerMockProvider registers a MockProvider for the given model under
// a fixed provider id. Returns the mock so the test can inspect recorded
// calls. The registry is package-global, so the test uses ResetRegistries
// in t.Cleanup to avoid bleeding into other suites.
func registerMockProvider(t *testing.T, model string) *helpers.MockProvider {
	t.Helper()
	mock := helpers.NewMockProvider("test-mock")
	providers.RegisterProvider(mock)
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:      "test-mock",
		ContextWindow:   8192,
		CostPer1kInput:  0.001, // 0.001 USD per 1k input tokens
		CostPer1kOutput: 0.002, // 0.002 USD per 1k output tokens
	})
	t.Cleanup(func() {
		providers.ResetRegistries()
	})
	return mock
}

// TestLLMCall_HappyPath exercises the success route end-to-end:
// validate inputs → resolve provider → fire before_provider_request →
// drain the stream → compute cost → emit engine_llm_call → return result.
//
// Locks in:
//   - The before_provider_request hook fires exactly once with the
//     correct payload shape (the visibility Chris's writeup wanted).
//   - Exactly one engine_llm_call event is emitted with the right
//     fields (model, provider, latencyMs, tokens, cost, jsonMode).
//   - The returned LLMCallResult mirrors the emitted event's token /
//     cost / content data.
func TestLLMCall_HappyPath(t *testing.T) {
	const model = "test-model-tiny"
	mock := registerMockProvider(t, model)
	mock.SetResponse(helpers.TextResponse("hello world"))

	acc := &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()}
	llmCall := BuildLLMCallFunc(acc)

	result, err := llmCall(extension.LLMCallOpts{
		Model:     model,
		System:    "be brief",
		Prompt:    "say hi",
		JSONMode:  true,
		MaxTokens: 50,
	})
	if err != nil {
		t.Fatalf("LLMCall returned error: %v", err)
	}
	if result == nil {
		t.Fatal("LLMCall returned nil result without error")
	}
	if result.Content != "hello world" {
		t.Errorf("Content = %q, want %q", result.Content, "hello world")
	}
	if result.InputTokens != 10 {
		t.Errorf("InputTokens = %d, want 10", result.InputTokens)
	}
	if result.OutputTokens != 5 {
		t.Errorf("OutputTokens = %d, want 5", result.OutputTokens)
	}
	// Cost = (10/1000 * 0.001) + (5/1000 * 0.002) = 0.00001 + 0.00001 = 0.00002.
	wantCost := 0.00002
	if diff := result.Cost - wantCost; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("Cost = %v, want %v", result.Cost, wantCost)
	}

	// One stream call recorded with the expected options.
	calls := mock.Calls()
	if len(calls) != 1 {
		t.Fatalf("provider Stream calls = %d, want 1", len(calls))
	}
	if calls[0].Model != model {
		t.Errorf("stream Model = %q, want %q", calls[0].Model, model)
	}
	if calls[0].System != "be brief" {
		t.Errorf("stream System = %q, want %q", calls[0].System, "be brief")
	}
	if calls[0].MaxTokens != 50 {
		t.Errorf("stream MaxTokens = %d, want 50", calls[0].MaxTokens)
	}
	if len(calls[0].Tools) != 0 {
		t.Errorf("stream Tools len = %d, want 0 (LLMCall must never carry tools)", len(calls[0].Tools))
	}

	// Exactly one engine_llm_call event emitted, no others.
	events := acc.Emitted()
	if len(events) != 1 {
		t.Fatalf("emitted events = %d, want 1; got: %+v", len(events), events)
	}
	ev := events[0]
	if ev.Type != "engine_llm_call" {
		t.Errorf("event.Type = %q, want engine_llm_call", ev.Type)
	}
	if ev.LlmCallModel != model {
		t.Errorf("event.LlmCallModel = %q, want %q", ev.LlmCallModel, model)
	}
	if ev.LlmCallProvider != "test-mock" {
		t.Errorf("event.LlmCallProvider = %q, want test-mock", ev.LlmCallProvider)
	}
	if ev.LlmCallInputTokens != 10 {
		t.Errorf("event.LlmCallInputTokens = %d, want 10", ev.LlmCallInputTokens)
	}
	if ev.LlmCallOutputTokens != 5 {
		t.Errorf("event.LlmCallOutputTokens = %d, want 5", ev.LlmCallOutputTokens)
	}
	if !ev.LlmCallJsonMode {
		t.Error("event.LlmCallJsonMode = false, want true")
	}
	if ev.LlmCallLatencyMs < 0 {
		t.Errorf("event.LlmCallLatencyMs = %d, want >= 0", ev.LlmCallLatencyMs)
	}
	if diff := ev.LlmCallCost - wantCost; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("event.LlmCallCost = %v, want %v", ev.LlmCallCost, wantCost)
	}
}

// TestLLMCall_MissingModelReturnsError covers the validation gate that
// rejects empty Model before touching the provider registry.
func TestLLMCall_MissingModelReturnsError(t *testing.T) {
	acc := &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()}
	llmCall := BuildLLMCallFunc(acc)

	result, err := llmCall(extension.LLMCallOpts{Model: "", Prompt: "hi"})
	if err == nil {
		t.Fatal("expected error for empty Model, got nil")
	}
	if result != nil {
		t.Errorf("expected nil result on error, got %+v", result)
	}
	if !strings.Contains(err.Error(), "model is required") {
		t.Errorf("error message = %q, want it to mention 'model is required'", err.Error())
	}
	if len(acc.Emitted()) != 0 {
		t.Errorf("no engine_llm_call event should fire on error path; got %d events", len(acc.Emitted()))
	}
}

// TestLLMCall_MissingPromptReturnsError covers the validation gate that
// rejects empty Prompt — same shape as the model-empty case.
func TestLLMCall_MissingPromptReturnsError(t *testing.T) {
	acc := &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()}
	llmCall := BuildLLMCallFunc(acc)

	result, err := llmCall(extension.LLMCallOpts{Model: "anything", Prompt: ""})
	if err == nil {
		t.Fatal("expected error for empty Prompt, got nil")
	}
	if result != nil {
		t.Errorf("expected nil result on error, got %+v", result)
	}
	if !strings.Contains(err.Error(), "prompt is required") {
		t.Errorf("error message = %q, want it to mention 'prompt is required'", err.Error())
	}
}

// TestLLMCall_UnknownModelReturnsError verifies that an unresolved model
// short-circuits before the stream is opened. No event is emitted, and
// the error carries the model name so a developer can see what failed.
func TestLLMCall_UnknownModelReturnsError(t *testing.T) {
	// Reset before AND after — no model registered means ResolveProvider
	// returns nil for our test model name.
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	acc := &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()}
	llmCall := BuildLLMCallFunc(acc)

	result, err := llmCall(extension.LLMCallOpts{
		Model:  "no-such-model-anywhere",
		Prompt: "anything",
	})
	if err == nil {
		t.Fatal("expected error for unknown model, got nil")
	}
	if result != nil {
		t.Errorf("expected nil result on error, got %+v", result)
	}
	if !strings.Contains(err.Error(), "no-such-model-anywhere") {
		t.Errorf("error %q should mention the offending model name", err.Error())
	}
	if len(acc.Emitted()) != 0 {
		t.Errorf("no events should fire on unresolved-model path; got %d", len(acc.Emitted()))
	}
}

// TestLLMCall_ProviderErrorReturnsError verifies that a provider stream
// failure propagates as a Go error and does not emit engine_llm_call.
// The error path is intentionally event-free: the caller surfaces a
// harness-level event if they want one.
func TestLLMCall_ProviderErrorReturnsError(t *testing.T) {
	const model = "test-model-err"
	mock := registerMockProvider(t, model)
	mock.SetResponseWithError(nil, errors.New("upstream broke"))

	acc := &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()}
	llmCall := BuildLLMCallFunc(acc)

	result, err := llmCall(extension.LLMCallOpts{Model: model, Prompt: "hi"})
	if err == nil {
		t.Fatal("expected provider error to propagate, got nil")
	}
	if result != nil {
		t.Errorf("expected nil result on provider error, got %+v", result)
	}
	if !strings.Contains(err.Error(), "upstream broke") {
		t.Errorf("error %q should wrap the provider error", err.Error())
	}
	if len(acc.Emitted()) != 0 {
		t.Errorf("no engine_llm_call event should fire on provider error; got %d", len(acc.Emitted()))
	}
}

// TestLLMCall_UnknownModelInRegistryCostZero verifies the cost-fallback
// branch: a model that resolves to a provider but is missing from the
// model registry yields Cost=0 (the "unknown" sentinel) rather than
// panicking or returning a bogus value.
func TestLLMCall_UnknownModelInRegistryCostZero(t *testing.T) {
	// Register the provider but NOT the model — ResolveProvider's prefix
	// matcher should still find a provider via the "qwen" prefix → "ollama"
	// route. We use the explicit RegisterProvider path so we can ID it.
	providers.ResetRegistries()
	t.Cleanup(func() { providers.ResetRegistries() })

	mock := helpers.NewMockProvider("ollama")
	providers.RegisterProvider(mock)
	// Intentionally NO RegisterModel call.
	mock.SetResponse(helpers.TextResponse("hi"))

	acc := &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()}
	llmCall := BuildLLMCallFunc(acc)

	// "qwen2-7b" matches the qwen-prefix branch in ResolveProvider →
	// "ollama" provider. GetModelInfo will return nil → cost = 0.
	result, err := llmCall(extension.LLMCallOpts{Model: "qwen2-7b", Prompt: "hi"})
	if err != nil {
		t.Fatalf("LLMCall returned error: %v", err)
	}
	if result.Cost != 0 {
		t.Errorf("Cost = %v, want 0 for unregistered model", result.Cost)
	}
	events := acc.Emitted()
	if len(events) != 1 {
		t.Fatalf("emitted events = %d, want 1", len(events))
	}
	if events[0].LlmCallCost != 0 {
		t.Errorf("event.LlmCallCost = %v, want 0", events[0].LlmCallCost)
	}
}

// TestLLMCall_FiresBeforeProviderRequestExactlyOnce locks in the hook
// visibility that Chris's writeup specifically called out as missing.
// LLMCall must fan the hook out via the ExtensionGroup just like the
// agent loop does — but only once per call (no double-firing, no
// silent skipping).
func TestLLMCall_FiresBeforeProviderRequestExactlyOnce(t *testing.T) {
	const model = "test-model-hook"
	mock := registerMockProvider(t, model)
	mock.SetResponse(helpers.TextResponse("ok"))

	// Build an ExtensionGroup with one Host that observes
	// before_provider_request. We never spawn a subprocess; we register
	// the handler directly on the Host's SDK, which is the same code
	// path real extensions land on after the init handshake.
	host := extension.NewHost()
	var (
		hookFires    int
		recordedInfo extension.BeforeProviderRequestInfo
		mu           sync.Mutex
	)
	host.SDK().On(extension.HookBeforeProviderRequest, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		mu.Lock()
		defer mu.Unlock()
		hookFires++
		if info, ok := payload.(extension.BeforeProviderRequestInfo); ok {
			recordedInfo = info
		}
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	acc := &llmCallTestAccessor{extGroup: group}
	llmCall := BuildLLMCallFunc(acc)

	_, err := llmCall(extension.LLMCallOpts{
		Model:     model,
		System:    "sys",
		Prompt:    "hi",
		MaxTokens: 25,
	})
	if err != nil {
		t.Fatalf("LLMCall returned error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if hookFires != 1 {
		t.Fatalf("before_provider_request fires = %d, want exactly 1", hookFires)
	}
	if recordedInfo.Model != model {
		t.Errorf("hook payload Model = %q, want %q", recordedInfo.Model, model)
	}
	if recordedInfo.Provider != "test-mock" {
		t.Errorf("hook payload Provider = %q, want test-mock", recordedInfo.Provider)
	}
	if recordedInfo.MessageCount != 1 {
		t.Errorf("hook payload MessageCount = %d, want 1 (LLMCall is one-shot)", recordedInfo.MessageCount)
	}
	if recordedInfo.ToolCount != 0 {
		t.Errorf("hook payload ToolCount = %d, want 0 (LLMCall has no tools)", recordedInfo.ToolCount)
	}
	if !recordedInfo.HasSystemPrompt {
		t.Error("hook payload HasSystemPrompt = false, want true (System was 'sys')")
	}
	if recordedInfo.MaxTokens != 25 {
		t.Errorf("hook payload MaxTokens = %d, want 25", recordedInfo.MaxTokens)
	}
	if recordedInfo.TurnNumber != 0 {
		t.Errorf("hook payload TurnNumber = %d, want 0 (LLMCall is not part of a turn sequence)", recordedInfo.TurnNumber)
	}
}
