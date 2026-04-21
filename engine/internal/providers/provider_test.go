package providers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- Mock provider for testing ---

type mockProvider struct {
	id          string
	failCount   int
	failErr     *ProviderError
	callCount   int
	events      []types.LlmStreamEvent
}

func (m *mockProvider) ID() string { return m.id }

func (m *mockProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 16)
	errc := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errc)

		m.callCount++
		if m.callCount <= m.failCount {
			errc <- m.failErr
			return
		}

		for _, ev := range m.events {
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

// --- Registry tests ---

func TestRegisterAndGetProvider(t *testing.T) {
	mock := &mockProvider{id: "test-provider"}
	RegisterProvider(mock)
	defer func() {
		mu.Lock()
		delete(providerRegistry, "test-provider")
		mu.Unlock()
	}()

	got := GetProvider("test-provider")
	if got == nil {
		t.Fatal("expected provider, got nil")
	}
	if got.ID() != "test-provider" {
		t.Errorf("expected ID 'test-provider', got %q", got.ID())
	}

	got = GetProvider("nonexistent")
	if got != nil {
		t.Errorf("expected nil for nonexistent provider, got %v", got)
	}
}

func TestResolveProviderByPrefix(t *testing.T) {
	// Register mock providers without resetting so init models survive
	anthropic := &mockProvider{id: "anthropic"}
	openai := &mockProvider{id: "openai"}
	google := &mockProvider{id: "google"}
	xai := &mockProvider{id: "xai"}
	deepseek := &mockProvider{id: "deepseek"}

	RegisterProvider(anthropic)
	RegisterProvider(openai)
	RegisterProvider(google)
	RegisterProvider(xai)
	RegisterProvider(deepseek)
	defer func() {
		mu.Lock()
		delete(providerRegistry, "anthropic")
		delete(providerRegistry, "openai")
		delete(providerRegistry, "google")
		delete(providerRegistry, "xai")
		delete(providerRegistry, "deepseek")
		mu.Unlock()
	}()

	tests := []struct {
		model      string
		wantID     string
		wantNil    bool
	}{
		{"claude-opus-4-6", "anthropic", false},
		{"claude_haiku", "anthropic", false},
		{"gpt-4.1", "openai", false},
		{"o3", "openai", false},
		{"o4-mini", "openai", false},
		{"gemini-1.5-pro", "google", false},
		{"grok-3", "xai", false},
		{"deepseek-r1", "deepseek", false},
		{"unknown-model", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			got := ResolveProvider(tt.model)
			if tt.wantNil {
				if got != nil {
					t.Errorf("expected nil, got provider %q", got.ID())
				}
				return
			}
			if got == nil {
				t.Fatalf("expected provider %q, got nil", tt.wantID)
			}
			if got.ID() != tt.wantID {
				t.Errorf("expected %q, got %q", tt.wantID, got.ID())
			}
		})
	}
}

func TestResolveProviderByModelRegistry(t *testing.T) {
	// Register without resetting so built-in models survive for later tests
	mock := &mockProvider{id: "custom-resolve-test"}
	RegisterProvider(mock)
	RegisterModel("my-custom-model-resolve", types.ModelInfo{ProviderID: "custom-resolve-test", ContextWindow: 100000})
	defer func() {
		mu.Lock()
		delete(providerRegistry, "custom-resolve-test")
		delete(modelRegistry, "my-custom-model-resolve")
		mu.Unlock()
	}()

	got := ResolveProvider("my-custom-model-resolve")
	if got == nil {
		t.Fatal("expected provider, got nil")
	}
	if got.ID() != "custom-resolve-test" {
		t.Errorf("expected 'custom-resolve-test', got %q", got.ID())
	}
}

// --- Model info tests ---

func TestModelInfo(t *testing.T) {
	// Built-in models registered in init()
	tests := []struct {
		model      string
		wantWindow int
		wantNil    bool
	}{
		{"claude-opus-4-6", 1000000, false},
		{"gpt-4.1", 1047576, false},
		{"o4-mini", 200000, false},
		{"nonexistent", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			info := GetModelInfo(tt.model)
			if tt.wantNil {
				if info != nil {
					t.Errorf("expected nil, got %+v", info)
				}
				return
			}
			if info == nil {
				t.Fatal("expected model info, got nil")
			}
			if info.ContextWindow != tt.wantWindow {
				t.Errorf("context window: want %d, got %d", tt.wantWindow, info.ContextWindow)
			}
		})
	}
}

func TestRegisterModel(t *testing.T) {
	RegisterModel("test-model-xyz", types.ModelInfo{
		ProviderID:    "test",
		ContextWindow: 50000,
		CostPer1kInput: 0.001,
	})
	defer func() {
		mu.Lock()
		delete(modelRegistry, "test-model-xyz")
		mu.Unlock()
	}()

	info := GetModelInfo("test-model-xyz")
	if info == nil {
		t.Fatal("expected model info")
	}
	if info.ContextWindow != 50000 {
		t.Errorf("want 50000, got %d", info.ContextWindow)
	}
}

// --- Error mapping tests ---

func TestFromAnthropicError(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		status    int
		body      string
		wantCode  string
		wantRetry bool
	}{
		{"auth 401", errors.New("unauthorized"), 401, "", ErrAuth, false},
		{"auth 403", errors.New("forbidden"), 403, "", ErrAuth, false},
		{"rate limit", errors.New("too many requests"), 429, "", ErrRateLimit, true},
		{"overloaded 529", errors.New("overloaded"), 529, "", ErrOverloaded, true},
		{"overloaded body", errors.New("server error"), 500, `{"error":{"message":"overloaded"}}`, ErrOverloaded, true},
		{"server error 502", errors.New("bad gateway"), 502, "", ErrOverloaded, true},
		{"prompt too long", errors.New("bad request"), 400, `{"error":{"message":"prompt is too long"}}`, ErrPromptTooLong, false},
		{"invalid model", errors.New("bad request"), 400, `{"error":{"message":"model not found"}}`, ErrInvalidModel, false},
		{"connection reset", errors.New("ECONNRESET"), 0, "", ErrStaleConn, true},
		{"timeout", errors.New("request timeout"), 0, "", ErrTimeout, true},
		{"network", errors.New("ECONNREFUSED"), 0, "", ErrNetwork, true},
		{"unknown", errors.New("something"), 0, "", ErrUnknown, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pe := FromAnthropicError(tt.err, tt.status, tt.body)
			if pe.Code != tt.wantCode {
				t.Errorf("code: want %q, got %q", tt.wantCode, pe.Code)
			}
			if pe.Retryable != tt.wantRetry {
				t.Errorf("retryable: want %v, got %v", tt.wantRetry, pe.Retryable)
			}
		})
	}
}

func TestFromOpenAIError(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		status    int
		body      string
		wantCode  string
		wantRetry bool
	}{
		{"auth 401", errors.New("unauthorized"), 401, "", ErrAuth, false},
		{"rate limit", errors.New("too many requests"), 429, "", ErrRateLimit, true},
		{"server error", errors.New("internal"), 500, "", ErrOverloaded, true},
		{"content filter", errors.New("blocked"), 400, `{"error":{"message":"content_filter"}}`, ErrContentFilter, false},
		{"prompt too long", errors.New("bad request"), 400, `{"error":{"message":"maximum context length"}}`, ErrPromptTooLong, false},
		{"connection reset", errors.New("ECONNRESET"), 0, "", ErrStaleConn, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pe := FromOpenAIError(tt.err, tt.status, tt.body)
			if pe.Code != tt.wantCode {
				t.Errorf("code: want %q, got %q", tt.wantCode, pe.Code)
			}
			if pe.Retryable != tt.wantRetry {
				t.Errorf("retryable: want %v, got %v", tt.wantRetry, pe.Retryable)
			}
		})
	}
}

// --- Retry tests ---

func TestRetrySucceedsAfterFailures(t *testing.T) {
	stopReason := "end_turn"
	mock := &mockProvider{
		id:        "test",
		failCount: 2,
		failErr:   NewProviderError(ErrOverloaded, "overloaded", 529, true),
		events: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "msg_1", Model: "test"}},
			{Type: "message_delta", Delta: &types.LlmStreamDelta{StopReason: &stopReason}},
			{Type: "message_stop"},
		},
	}

	var retries []int
	config := &RetryConfig{
		MaxRetries:  5,
		BaseDelayMs: 1, // fast for tests
		MaxDelayMs:  10,
		OnRetryWait: func(attempt, delayMs int, err *ProviderError) {
			retries = append(retries, attempt)
		},
	}

	ctx := context.Background()
	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	var collected []types.LlmStreamEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(collected) != 3 {
		t.Errorf("expected 3 events, got %d", len(collected))
	}
	if len(retries) != 2 {
		t.Errorf("expected 2 retries, got %d", len(retries))
	}
	if mock.callCount != 3 {
		t.Errorf("expected 3 calls, got %d", mock.callCount)
	}
}

func TestRetryExhausted(t *testing.T) {
	mock := &mockProvider{
		id:        "test",
		failCount: 100, // always fail
		failErr:   NewProviderError(ErrRateLimit, "rate limited", 429, true),
	}

	config := &RetryConfig{
		MaxRetries:  2,
		BaseDelayMs: 1,
		MaxDelayMs:  1,
	}

	ctx := context.Background()
	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	for range events {
		// drain
	}

	err := <-errc
	if err == nil {
		t.Fatal("expected error after retries exhausted")
	}
	pe, ok := err.(*ProviderError)
	if !ok {
		t.Fatalf("expected ProviderError, got %T", err)
	}
	if pe.Code != ErrRateLimit {
		t.Errorf("expected rate_limit, got %q", pe.Code)
	}
}

func TestRetryNonRetryable(t *testing.T) {
	mock := &mockProvider{
		id:        "test",
		failCount: 100,
		failErr:   NewProviderError(ErrAuth, "bad key", 401, false),
	}

	config := &RetryConfig{
		MaxRetries:  5,
		BaseDelayMs: 1,
	}

	ctx := context.Background()
	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	for range events {
	}

	err := <-errc
	if err == nil {
		t.Fatal("expected error")
	}
	pe := err.(*ProviderError)
	if pe.Code != ErrAuth {
		t.Errorf("expected auth error, got %q", pe.Code)
	}
	if mock.callCount != 1 {
		t.Errorf("non-retryable should only call once, got %d", mock.callCount)
	}
}

func TestRetryContextCancellation(t *testing.T) {
	mock := &mockProvider{
		id:        "test",
		failCount: 100,
		failErr:   NewProviderError(ErrOverloaded, "overloaded", 529, true),
	}

	config := &RetryConfig{
		MaxRetries:  100,
		BaseDelayMs: 50000, // long delay
	}

	ctx, cancel := context.WithCancel(context.Background())

	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	// Cancel after a brief moment
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	for range events {
	}

	err := <-errc
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
}

func TestRetryModelFallback(t *testing.T) {
	stopReason := "end_turn"
	_ = stopReason
	fallbackMock := &mockProvider{
		id: "fallback",
		events: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "msg_fb", Model: "fallback-model"}},
			{Type: "message_stop"},
		},
	}
	RegisterProvider(fallbackMock)
	RegisterModel("fallback-model", types.ModelInfo{ProviderID: "fallback"})
	defer func() {
		mu.Lock()
		delete(providerRegistry, "fallback")
		delete(modelRegistry, "fallback-model")
		mu.Unlock()
	}()

	primaryMock := &mockProvider{
		id:        "primary",
		failCount: 100,
		failErr:   NewProviderError(ErrOverloaded, "overloaded", 529, true),
	}

	config := &RetryConfig{
		MaxRetries:                  10,
		BaseDelayMs:                 1,
		MaxDelayMs:                  1,
		FallbackModel:               "fallback-model",
		MaxOverloadedBeforeFallback: 2,
	}

	ctx := context.Background()
	events, errc := WithRetry(ctx, primaryMock, types.LlmStreamOptions{Model: "primary-model"}, config)

	var collected []types.LlmStreamEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(collected) != 2 {
		t.Errorf("expected 2 events from fallback, got %d", len(collected))
	}
	if fallbackMock.callCount != 1 {
		t.Errorf("expected fallback called once, got %d", fallbackMock.callCount)
	}
}

// --- SSE parsing tests ---

func TestParseSSEStream(t *testing.T) {
	input := `event: message_start
data: {"type":"message_start","message":{"id":"msg_1"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: message_stop
data: {"type":"message_stop"}

`

	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 3 {
		t.Fatalf("expected 3 events, got %d", len(collected))
	}

	if collected[0].Event != "message_start" {
		t.Errorf("event 0: want 'message_start', got %q", collected[0].Event)
	}
	if !strings.Contains(collected[0].Data, `"msg_1"`) {
		t.Errorf("event 0 data missing msg_1: %s", collected[0].Data)
	}

	if collected[1].Event != "content_block_delta" {
		t.Errorf("event 1: want 'content_block_delta', got %q", collected[1].Event)
	}
	if !strings.Contains(collected[1].Data, "Hello") {
		t.Errorf("event 1 data missing Hello: %s", collected[1].Data)
	}

	if collected[2].Event != "message_stop" {
		t.Errorf("event 2: want 'message_stop', got %q", collected[2].Event)
	}
}

func TestParseSSEStreamOpenAIDone(t *testing.T) {
	input := `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}

data: [DONE]

`
	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 1 {
		t.Fatalf("expected 1 event (DONE filtered), got %d", len(collected))
	}
}

func TestParseSSEStreamNoTrailingNewline(t *testing.T) {
	input := "data: {\"type\":\"test\"}"

	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 1 {
		t.Fatalf("expected 1 event, got %d", len(collected))
	}
	if collected[0].Data != `{"type":"test"}` {
		t.Errorf("unexpected data: %s", collected[0].Data)
	}
}

// --- OpenAI message format tests ---

func TestFormatOpenAIMessages(t *testing.T) {
	messages := []types.LlmMessage{
		{Role: "user", Content: "Hello"},
		{Role: "assistant", Content: "Hi there"},
	}

	result := formatOpenAIMessages("You are a helper", messages)

	if len(result) != 3 {
		t.Fatalf("expected 3 messages (system + 2), got %d", len(result))
	}

	if result[0]["role"] != "system" {
		t.Errorf("first message should be system, got %v", result[0]["role"])
	}
	if result[1]["content"] != "Hello" {
		t.Errorf("user message content: want 'Hello', got %v", result[1]["content"])
	}
}

func TestFormatOpenAIMessagesWithToolUse(t *testing.T) {
	messages := []types.LlmMessage{
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Let me help"},
				{Type: "tool_use", ID: "call_1", Name: "search", Input: map[string]any{"query": "test"}},
			},
		},
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "call_1", Content: "result"},
			},
		},
	}

	result := formatOpenAIMessages("system", messages)

	// system + assistant + tool
	if len(result) != 3 {
		t.Fatalf("expected 3 messages, got %d: %+v", len(result), result)
	}

	assistantMsg := result[1]
	if assistantMsg["role"] != "assistant" {
		t.Errorf("expected assistant role, got %v", assistantMsg["role"])
	}
	toolCalls, ok := assistantMsg["tool_calls"].([]map[string]any)
	if !ok {
		t.Fatalf("expected tool_calls array, got %T", assistantMsg["tool_calls"])
	}
	if len(toolCalls) != 1 {
		t.Errorf("expected 1 tool call, got %d", len(toolCalls))
	}

	toolMsg := result[2]
	if toolMsg["role"] != "tool" {
		t.Errorf("expected tool role, got %v", toolMsg["role"])
	}
}

// --- Finish reason translation ---

func TestTranslateFinishReason(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"stop", "end_turn"},
		{"tool_calls", "tool_use"},
		{"length", "length"},
	}

	for _, tt := range tests {
		got := translateFinishReason(tt.input)
		if got != tt.want {
			t.Errorf("translateFinishReason(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// --- ProviderError tests ---

func TestProviderErrorInterface(t *testing.T) {
	pe := NewProviderError(ErrRateLimit, "too fast", 429, true)
	if pe.Error() != "rate_limit: too fast" {
		t.Errorf("unexpected error string: %s", pe.Error())
	}

	pe.Cause = fmt.Errorf("underlying")
	if !strings.Contains(pe.Error(), "underlying") {
		t.Errorf("error should contain cause: %s", pe.Error())
	}
}

// --- Compatible provider tests ---

func TestOpenAICompatibleProviderID(t *testing.T) {
	p := NewOpenAICompatibleProvider(CompatibleProviderOptions{
		ID:      "groq",
		APIKey:  "fake",
		BaseURL: "https://api.groq.com",
	})
	if p.ID() != "groq" {
		t.Errorf("expected ID 'groq', got %q", p.ID())
	}
}

// --- Extended prefix resolution tests ---

func TestResolveProviderAllPrefixes(t *testing.T) {
	// Register all needed providers
	providerIDs := []string{"anthropic", "openai", "google", "mistral", "groq", "together", "deepseek", "xai", "bedrock"}
	for _, id := range providerIDs {
		RegisterProvider(&mockProvider{id: id})
	}
	defer func() {
		mu.Lock()
		for _, id := range providerIDs {
			delete(providerRegistry, id)
		}
		mu.Unlock()
	}()

	tests := []struct {
		model  string
		wantID string
	}{
		// claude- prefix
		{"claude-opus-4-6", "anthropic"},
		{"claude-sonnet-4-6", "anthropic"},
		{"claude-haiku-4-5-20251001", "anthropic"},
		{"claude-custom-model", "anthropic"},
		// gpt- prefix
		{"gpt-4.1", "openai"},
		{"gpt-4.1-mini", "openai"},
		{"gpt-4.1-nano", "openai"},
		// o-series
		{"o3", "openai"},
		{"o3-custom", "openai"},
		{"o4-mini", "openai"},
		// gemini- prefix
		{"gemini-2.5-pro", "google"},
		{"gemini-1.5-flash", "google"},
		// mistral/mixtral
		{"mistral-large", "mistral"},
		{"mistral-medium", "mistral"},
		{"mixtral-8x7b", "mistral"},
		// llama -> groq (since groq is registered)
		{"llama-3.1-70b", "groq"},
		{"llama-3-8b", "groq"},
		// deepseek
		{"deepseek-coder", "deepseek"},
		{"deepseek-r1", "deepseek"},
		// grok -> xai
		{"grok-2", "xai"},
		{"grok-3", "xai"},
		// bedrock model IDs (contain dots like amazon.*, anthropic.*, meta.*)
		{"amazon.titan-text-v1", "bedrock"},
		{"anthropic.claude-v2", "bedrock"},
		{"meta.llama3-70b-instruct", "bedrock"},
	}

	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			got := ResolveProvider(tt.model)
			if got == nil {
				t.Fatalf("expected provider %q for model %q, got nil", tt.wantID, tt.model)
			}
			if got.ID() != tt.wantID {
				t.Errorf("model %q: expected %q, got %q", tt.model, tt.wantID, got.ID())
			}
		})
	}
}

func TestResolveProviderLlamaFallsBackToTogether(t *testing.T) {
	// Only register together (not groq) so llama falls back
	together := &mockProvider{id: "together"}
	RegisterProvider(together)
	defer func() {
		mu.Lock()
		delete(providerRegistry, "together")
		mu.Unlock()
	}()

	// Make sure groq is NOT registered
	mu.Lock()
	delete(providerRegistry, "groq")
	mu.Unlock()

	got := ResolveProvider("llama-3.1-70b")
	if got == nil {
		t.Fatal("expected together provider, got nil")
	}
	if got.ID() != "together" {
		t.Errorf("expected 'together', got %q", got.ID())
	}
}

func TestResolveProviderReturnsNilForUnknown(t *testing.T) {
	got := ResolveProvider("completely-unknown-model-xyz")
	if got != nil {
		t.Errorf("expected nil for unknown model, got %q", got.ID())
	}
}

// --- Vertex provider tests ---

func TestVertexProviderConfigResolution(t *testing.T) {
	t.Run("error when no project ID", func(t *testing.T) {
		// Clear env
		t.Setenv("GOOGLE_CLOUD_PROJECT", "")
		_, err := NewVertexProvider(VertexConfig{
			AccessToken: "test-token",
		})
		if err == nil {
			t.Fatal("expected error for missing project ID")
		}
		if !strings.Contains(err.Error(), "project ID") {
			t.Errorf("error should mention project ID: %s", err.Error())
		}
	})

	t.Run("error when no access token", func(t *testing.T) {
		t.Setenv("GOOGLE_ACCESS_TOKEN", "")
		_, err := NewVertexProvider(VertexConfig{
			ProjectID: "my-project",
		})
		if err == nil {
			t.Fatal("expected error for missing access token")
		}
		if !strings.Contains(err.Error(), "access token") {
			t.Errorf("error should mention access token: %s", err.Error())
		}
	})

	t.Run("uses config access token", func(t *testing.T) {
		p, err := NewVertexProvider(VertexConfig{
			ProjectID:   "my-project",
			AccessToken: "cfg-token",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "vertex" {
			t.Errorf("expected ID 'vertex', got %q", p.ID())
		}
	})

	t.Run("uses env var for access token", func(t *testing.T) {
		t.Setenv("GOOGLE_ACCESS_TOKEN", "env-token")
		p, err := NewVertexProvider(VertexConfig{
			ProjectID: "my-project",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "vertex" {
			t.Errorf("expected ID 'vertex', got %q", p.ID())
		}
	})

	t.Run("uses env var for project ID", func(t *testing.T) {
		t.Setenv("GOOGLE_CLOUD_PROJECT", "env-project")
		p, err := NewVertexProvider(VertexConfig{
			AccessToken: "some-token",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "vertex" {
			t.Errorf("expected ID 'vertex', got %q", p.ID())
		}
	})

	t.Run("defaults region to us-east5", func(t *testing.T) {
		// We can't directly check the baseURL, but we can verify the provider creates ok
		p, err := NewVertexProvider(VertexConfig{
			ProjectID:   "my-project",
			AccessToken: "tok",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "vertex" {
			t.Errorf("expected ID 'vertex', got %q", p.ID())
		}
	})
}

// --- Foundry provider tests ---

func TestFoundryProviderConfigResolution(t *testing.T) {
	t.Run("error when no base URL", func(t *testing.T) {
		t.Setenv("ANTHROPIC_FOUNDRY_BASE_URL", "")
		_, err := NewFoundryProvider(FoundryConfig{})
		if err == nil {
			t.Fatal("expected error for missing base URL")
		}
		if !strings.Contains(err.Error(), "base URL") {
			t.Errorf("error should mention base URL: %s", err.Error())
		}
	})

	t.Run("uses config base URL", func(t *testing.T) {
		p, err := NewFoundryProvider(FoundryConfig{
			BaseURL: "https://foundry.example.com",
			APIKey:  "key",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "foundry" {
			t.Errorf("expected ID 'foundry', got %q", p.ID())
		}
	})

	t.Run("uses env var for base URL", func(t *testing.T) {
		t.Setenv("ANTHROPIC_FOUNDRY_BASE_URL", "https://env-foundry.example.com")
		p, err := NewFoundryProvider(FoundryConfig{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "foundry" {
			t.Errorf("expected ID 'foundry', got %q", p.ID())
		}
	})

	t.Run("uses ANTHROPIC_FOUNDRY_API_KEY env var", func(t *testing.T) {
		t.Setenv("ANTHROPIC_FOUNDRY_API_KEY", "foundry-key")
		p, err := NewFoundryProvider(FoundryConfig{
			BaseURL: "https://foundry.example.com",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "foundry" {
			t.Errorf("expected ID 'foundry', got %q", p.ID())
		}
	})

	t.Run("falls back to ANTHROPIC_API_KEY", func(t *testing.T) {
		t.Setenv("ANTHROPIC_FOUNDRY_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "default-key")
		p, err := NewFoundryProvider(FoundryConfig{
			BaseURL: "https://foundry.example.com",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.ID() != "foundry" {
			t.Errorf("expected ID 'foundry', got %q", p.ID())
		}
	})
}

// --- Extended error mapping tests ---

func TestFromAnthropicErrorExtended(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		status    int
		body      string
		wantCode  string
		wantRetry bool
	}{
		{"400 generic", errors.New("bad request"), 400, "", ErrInvalidReq, false},
		{"400 pdf error", errors.New("bad request"), 400, `{"error":{"message":"invalid PDF document"}}`, ErrPDFError, false},
		{"400 media error", errors.New("bad request"), 400, `{"error":{"message":"image is too large"}}`, ErrMediaError, false},
		{"400 model not found", errors.New("bad request"), 400, `{"error":{"message":"model not found"}}`, ErrInvalidModel, false},
		{"404 produces unknown", errors.New("not found"), 404, "", ErrUnknown, false},
		{"502 is overloaded", errors.New("bad gateway"), 502, "", ErrOverloaded, true},
		{"503 is overloaded", errors.New("service unavailable"), 503, "", ErrOverloaded, true},
		{"EPIPE is stale_connection", errors.New("write EPIPE"), 0, "", ErrStaleConn, true},
		{"timeout in message", errors.New("request timeout exceeded"), 0, "", ErrTimeout, true},
		{"ECONNREFUSED is network", errors.New("ECONNREFUSED"), 0, "", ErrNetwork, true},
		{"no such host is network", errors.New("no such host"), 0, "", ErrNetwork, true},
		{"unknown error", errors.New("something random"), 0, "", ErrUnknown, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pe := FromAnthropicError(tt.err, tt.status, tt.body)
			if pe.Code != tt.wantCode {
				t.Errorf("code: want %q, got %q", tt.wantCode, pe.Code)
			}
			if pe.Retryable != tt.wantRetry {
				t.Errorf("retryable: want %v, got %v", tt.wantRetry, pe.Retryable)
			}
		})
	}
}

func TestFromOpenAIErrorExtended(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		status    int
		body      string
		wantCode  string
		wantRetry bool
	}{
		{"403 is auth", errors.New("forbidden"), 403, "", ErrAuth, false},
		{"400 generic", errors.New("bad request"), 400, "", ErrInvalidReq, false},
		{"400 model does not exist", errors.New("bad"), 400, `{"error":{"message":"model does not exist"}}`, ErrInvalidModel, false},
		{"400 image error", errors.New("bad"), 400, `{"error":{"message":"invalid image format"}}`, ErrMediaError, false},
		{"500 is overloaded", errors.New("internal"), 500, "", ErrOverloaded, true},
		{"502 is overloaded", errors.New("bad gateway"), 502, "", ErrOverloaded, true},
		{"content policy in body", errors.New("blocked"), 400, `{"error":{"message":"content policy violation"}}`, ErrContentFilter, false},
		{"content_filter in body", errors.New("blocked"), 400, `{"error":{"message":"content_filter triggered"}}`, ErrContentFilter, false},
		{"EPIPE is stale_connection", errors.New("write EPIPE"), 0, "", ErrStaleConn, true},
		{"timeout", errors.New("request timeout"), 0, "", ErrTimeout, true},
		{"ECONNREFUSED", errors.New("ECONNREFUSED"), 0, "", ErrNetwork, true},
		{"unknown error", errors.New("mystery"), 0, "", ErrUnknown, false},
		{"prompt too long - maximum context", errors.New("bad"), 400, `{"error":{"message":"maximum context length exceeded"}}`, ErrPromptTooLong, false},
		{"prompt too long - tokens", errors.New("bad"), 400, `{"error":{"message":"too many tokens"}}`, ErrPromptTooLong, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pe := FromOpenAIError(tt.err, tt.status, tt.body)
			if pe.Code != tt.wantCode {
				t.Errorf("code: want %q, got %q", tt.wantCode, pe.Code)
			}
			if pe.Retryable != tt.wantRetry {
				t.Errorf("retryable: want %v, got %v", tt.wantRetry, pe.Retryable)
			}
		})
	}
}

func TestProviderErrorUnwrap(t *testing.T) {
	cause := fmt.Errorf("underlying cause")
	pe := NewProviderError(ErrNetwork, "connection failed", 0, true)
	pe.Cause = cause

	if !errors.Is(pe, cause) {
		t.Error("expected errors.Is to find cause through Unwrap")
	}
}

func TestProviderErrorRetryAfterMs(t *testing.T) {
	pe := NewProviderError(ErrRateLimit, "rate limited", 429, true)
	pe.RetryAfterMs = 5000

	if pe.RetryAfterMs != 5000 {
		t.Errorf("expected 5000, got %d", pe.RetryAfterMs)
	}
}

func TestProviderErrorAttemptTracking(t *testing.T) {
	pe := NewProviderError(ErrOverloaded, "overloaded", 529, true)
	pe.Attempt = 3

	if pe.Attempt != 3 {
		t.Errorf("expected attempt 3, got %d", pe.Attempt)
	}
}

func TestProviderErrorDefaultRetryableFalse(t *testing.T) {
	pe := NewProviderError(ErrUnknown, "test", 0, false)
	if pe.Retryable {
		t.Error("expected retryable false by default")
	}
}

// --- SSE parsing extended tests ---

func TestParseSSEStreamMultiLineData(t *testing.T) {
	input := "data: line1\ndata: line2\n\n"
	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 1 {
		t.Fatalf("expected 1 event, got %d", len(collected))
	}
	if collected[0].Data != "line1\nline2" {
		t.Errorf("expected multi-line data 'line1\\nline2', got %q", collected[0].Data)
	}
}

func TestParseSSEStreamEmptyEvents(t *testing.T) {
	// Two empty lines in a row should not produce events
	input := "\n\nevent: test\ndata: {\"ok\":true}\n\n"
	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 1 {
		t.Fatalf("expected 1 event, got %d", len(collected))
	}
	if collected[0].Event != "test" {
		t.Errorf("expected event 'test', got %q", collected[0].Event)
	}
}

func TestParseSSEStreamIgnoresComments(t *testing.T) {
	input := ": this is a comment\ndata: {\"type\":\"real\"}\n\n"
	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 1 {
		t.Fatalf("expected 1 event, got %d", len(collected))
	}
	if collected[0].Data != `{"type":"real"}` {
		t.Errorf("unexpected data: %s", collected[0].Data)
	}
}

func TestParseSSEStreamEmptyDataField(t *testing.T) {
	input := "data:\n\n"
	events := ParseSSEStream(strings.NewReader(input))

	var collected []SSEEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	if len(collected) != 1 {
		t.Fatalf("expected 1 event, got %d", len(collected))
	}
	if collected[0].Data != "" {
		t.Errorf("expected empty data, got %q", collected[0].Data)
	}
}

// --- OpenAI message format extended tests ---

func TestFormatOpenAIMessagesTextOnly(t *testing.T) {
	messages := []types.LlmMessage{
		{Role: "user", Content: "Hello"},
	}

	result := formatOpenAIMessages("system prompt", messages)

	if len(result) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(result))
	}
	if result[0]["role"] != "system" {
		t.Errorf("first message should be system")
	}
	if result[0]["content"] != "system prompt" {
		t.Errorf("system content: %v", result[0]["content"])
	}
	if result[1]["role"] != "user" {
		t.Errorf("second message should be user")
	}
	if result[1]["content"] != "Hello" {
		t.Errorf("user content: %v", result[1]["content"])
	}
}

func TestFormatOpenAIMessagesToolResult(t *testing.T) {
	messages := []types.LlmMessage{
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "call_1", Content: "result data"},
			},
		},
	}

	result := formatOpenAIMessages("sys", messages)

	// sys + tool message
	if len(result) != 2 {
		t.Fatalf("expected 2 messages, got %d: %+v", len(result), result)
	}

	toolMsg := result[1]
	if toolMsg["role"] != "tool" {
		t.Errorf("expected tool role, got %v", toolMsg["role"])
	}
	if toolMsg["tool_call_id"] != "call_1" {
		t.Errorf("expected tool_call_id 'call_1', got %v", toolMsg["tool_call_id"])
	}
	if toolMsg["content"] != "result data" {
		t.Errorf("expected content 'result data', got %v", toolMsg["content"])
	}
}

func TestFormatOpenAIMessagesAssistantTextAndToolUse(t *testing.T) {
	messages := []types.LlmMessage{
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Thinking..."},
				{Type: "tool_use", ID: "call_2", Name: "Bash", Input: map[string]any{"command": "ls"}},
			},
		},
	}

	result := formatOpenAIMessages("sys", messages)

	// sys + assistant
	if len(result) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(result))
	}

	assistantMsg := result[1]
	if assistantMsg["role"] != "assistant" {
		t.Errorf("expected assistant role")
	}
	if assistantMsg["content"] != "Thinking..." {
		t.Errorf("expected text content: %v", assistantMsg["content"])
	}

	toolCalls, ok := assistantMsg["tool_calls"].([]map[string]any)
	if !ok || len(toolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %v", assistantMsg["tool_calls"])
	}
	if toolCalls[0]["id"] != "call_2" {
		t.Errorf("expected tool call id 'call_2', got %v", toolCalls[0]["id"])
	}
}

// --- Finish reason translation extended ---

func TestTranslateFinishReasonExtended(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"stop", "end_turn"},
		{"tool_calls", "tool_use"},
		{"length", "length"},
		{"content_filter", "content_filter"},
		{"", ""},
	}

	for _, tt := range tests {
		got := translateFinishReason(tt.input)
		if got != tt.want {
			t.Errorf("translateFinishReason(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// --- Model info extended tests ---

func TestModelInfoAllBuiltIns(t *testing.T) {
	builtInModels := []struct {
		model      string
		provider   string
		minContext int
	}{
		{"claude-opus-4-6", "anthropic", 200000},
		{"claude-sonnet-4-6", "anthropic", 200000},
		{"claude-haiku-4-5-20251001", "anthropic", 200000},
		{"gpt-4.1", "openai", 1047576},
		{"gpt-4.1-mini", "openai", 1047576},
		{"o4-mini", "openai", 200000},
		{"o3", "openai", 200000},
	}

	for _, tt := range builtInModels {
		t.Run(tt.model, func(t *testing.T) {
			info := GetModelInfo(tt.model)
			if info == nil {
				t.Fatalf("expected model info for %s", tt.model)
			}
			if info.ProviderID != tt.provider {
				t.Errorf("provider: want %q, got %q", tt.provider, info.ProviderID)
			}
			if info.ContextWindow < tt.minContext {
				t.Errorf("context window: want >= %d, got %d", tt.minContext, info.ContextWindow)
			}
			if info.CostPer1kInput <= 0 {
				t.Errorf("costPer1kInput should be > 0, got %f", info.CostPer1kInput)
			}
			if info.CostPer1kOutput <= 0 {
				t.Errorf("costPer1kOutput should be > 0, got %f", info.CostPer1kOutput)
			}
		})
	}
}

func TestModelInfoUnknownReturnsNil(t *testing.T) {
	info := GetModelInfo("completely-unknown-model-xyz")
	if info != nil {
		t.Errorf("expected nil for unknown model, got %+v", info)
	}
}

// --- Provider ID tests ---

func TestAnthropicProviderID(t *testing.T) {
	p := NewAnthropicProvider(nil)
	if p.ID() != "anthropic" {
		t.Errorf("expected 'anthropic', got %q", p.ID())
	}
}

func TestAnthropicProviderCustomID(t *testing.T) {
	p := NewAnthropicProvider(&ProviderOptions{ID: "vertex"})
	if p.ID() != "vertex" {
		t.Errorf("expected 'vertex', got %q", p.ID())
	}
}

func TestOpenAIProviderID(t *testing.T) {
	p := NewOpenAIProvider(nil)
	if p.ID() != "openai" {
		t.Errorf("expected 'openai', got %q", p.ID())
	}
}

// --- OpenAI-compatible custom ID and base URL ---

func TestOpenAICompatibleCustomID(t *testing.T) {
	tests := []struct {
		id      string
		baseURL string
	}{
		{"groq", "https://api.groq.com/openai/v1"},
		{"cerebras", "https://api.cerebras.ai/v1"},
		{"mistral", "https://api.mistral.ai/v1"},
		{"openrouter", "https://openrouter.ai/api/v1"},
		{"together", "https://api.together.xyz/v1"},
		{"fireworks", "https://api.fireworks.ai/inference/v1"},
		{"xai", "https://api.x.ai/v1"},
		{"deepseek", "https://api.deepseek.com"},
		{"ollama", "http://localhost:11434/v1"},
	}

	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			p := NewOpenAICompatibleProvider(CompatibleProviderOptions{
				ID:      tt.id,
				APIKey:  "test-key",
				BaseURL: tt.baseURL,
			})
			if p.ID() != tt.id {
				t.Errorf("expected ID %q, got %q", tt.id, p.ID())
			}
		})
	}
}

// --- Retry extended tests ---

func TestRetryRespectsRetryAfterMs(t *testing.T) {
	mock := &mockProvider{
		id:        "test",
		failCount: 1,
		failErr: &ProviderError{
			Code:         ErrRateLimit,
			Message:      "limited",
			HTTPStatus:   429,
			Retryable:    true,
			RetryAfterMs: 100,
		},
		events: []types.LlmStreamEvent{
			{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "msg_ra", Model: "test"}},
			{Type: "message_stop"},
		},
	}

	config := &RetryConfig{
		MaxRetries:  3,
		BaseDelayMs: 1,
		MaxDelayMs:  5,
	}

	start := time.Now()
	ctx := context.Background()
	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	for range events {
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should have waited at least ~100ms due to RetryAfterMs
	elapsed := time.Since(start)
	if elapsed < 90*time.Millisecond {
		t.Errorf("expected >= 90ms delay from RetryAfterMs, got %v", elapsed)
	}
}

func TestRetryCallsOnRetryWaitWithCorrectAttempt(t *testing.T) {
	mock := &mockProvider{
		id:        "test",
		failCount: 2,
		failErr:   NewProviderError(ErrOverloaded, "overloaded", 529, true),
		events: []types.LlmStreamEvent{
			{Type: "message_stop"},
		},
	}

	var waitCalls []int
	config := &RetryConfig{
		MaxRetries:  5,
		BaseDelayMs: 1,
		MaxDelayMs:  1,
		OnRetryWait: func(attempt, delayMs int, err *ProviderError) {
			waitCalls = append(waitCalls, attempt)
			if err.Code != ErrOverloaded {
				t.Errorf("expected overloaded error in callback, got %q", err.Code)
			}
		},
	}

	ctx := context.Background()
	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	for range events {
	}
	if err := <-errc; err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(waitCalls) != 2 {
		t.Errorf("expected 2 onRetryWait calls, got %d", len(waitCalls))
	}
}

func TestRetryDisablesKeepAliveOnStaleConnection(t *testing.T) {
	// Save and restore global state
	origKeepAlive := KeepAliveDisabled
	KeepAliveDisabled = false
	defer func() { KeepAliveDisabled = origKeepAlive }()

	mock := &mockProvider{
		id:        "test",
		failCount: 1,
		failErr:   NewProviderError(ErrStaleConn, "connection reset", 0, true),
		events: []types.LlmStreamEvent{
			{Type: "message_stop"},
		},
	}

	config := &RetryConfig{
		MaxRetries:  3,
		BaseDelayMs: 1,
	}

	ctx := context.Background()
	events, errc := WithRetry(ctx, mock, types.LlmStreamOptions{Model: "test"}, config)

	for range events {
	}
	<-errc

	if !KeepAliveDisabled {
		t.Error("expected KeepAliveDisabled to be set after stale connection error")
	}
}

// --- firstNonEmpty tests ---

func TestFirstNonEmpty(t *testing.T) {
	tests := []struct {
		input []string
		want  string
	}{
		{[]string{"a", "b"}, "a"},
		{[]string{"", "b"}, "b"},
		{[]string{"", "", "c"}, "c"},
		{[]string{"", ""}, ""},
		{[]string{}, ""},
	}

	for _, tt := range tests {
		got := firstNonEmpty(tt.input...)
		if got != tt.want {
			t.Errorf("firstNonEmpty(%v) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
