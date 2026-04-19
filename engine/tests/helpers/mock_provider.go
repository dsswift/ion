package helpers

import (
	"context"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// MockProvider returns scripted stream events. It implements providers.LlmProvider.
type MockProvider struct {
	id        string
	responses [][]types.LlmStreamEvent // one sequence per call
	errors    []error                  // one error per call (nil for no error)
	callCount int
	mu        sync.Mutex
	calls     []types.LlmStreamOptions // recorded calls
}

// NewMockProvider creates a MockProvider with the given ID.
func NewMockProvider(id string) *MockProvider {
	return &MockProvider{
		id: id,
	}
}

// ID returns the provider identifier.
func (m *MockProvider) ID() string {
	return m.id
}

// SetResponse adds a scripted response sequence for the next call.
func (m *MockProvider) SetResponse(events []types.LlmStreamEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.responses = append(m.responses, events)
	m.errors = append(m.errors, nil)
}

// SetResponseWithError adds a scripted response that ends with an error.
func (m *MockProvider) SetResponseWithError(events []types.LlmStreamEvent, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.responses = append(m.responses, events)
	m.errors = append(m.errors, err)
}

// CallCount returns how many times Stream was called.
func (m *MockProvider) CallCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.callCount
}

// Calls returns the recorded stream options from each call.
func (m *MockProvider) Calls() []types.LlmStreamOptions {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]types.LlmStreamOptions, len(m.calls))
	copy(out, m.calls)
	return out
}

// Stream implements LlmProvider.Stream. It returns the next scripted response
// sequence, cycling through configured responses.
func (m *MockProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	m.mu.Lock()
	idx := m.callCount
	m.callCount++
	m.calls = append(m.calls, opts)

	var evs []types.LlmStreamEvent
	var streamErr error
	if idx < len(m.responses) {
		evs = m.responses[idx]
		streamErr = m.errors[idx]
	} else if len(m.responses) > 0 {
		// Cycle the last response
		last := len(m.responses) - 1
		evs = m.responses[last]
		streamErr = m.errors[last]
	}
	m.mu.Unlock()

	go func() {
		defer close(events)
		defer close(errc)
		for _, ev := range evs {
			select {
			case events <- ev:
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			}
		}
		if streamErr != nil {
			errc <- streamErr
		}
	}()

	return events, errc
}

// --- Helper functions to build common event sequences ---

func strPtr(s string) *string { return &s }

// TextResponse returns a complete event sequence for a simple text response.
func TextResponse(text string) []types.LlmStreamEvent {
	stopReason := "end_turn"
	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    "msg_test_001",
				Model: "mock-model",
				Usage: types.LlmUsage{InputTokens: 10, OutputTokens: 0},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type: "text",
				Text: "",
			},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta: &types.LlmStreamDelta{
				Type: "text_delta",
				Text: text,
			},
		},
		{
			Type:       "content_block_stop",
			BlockIndex: 0,
		},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: 5},
		},
		{
			Type: "message_stop",
		},
	}
}

// ToolCallResponse returns events for a tool_use response.
func ToolCallResponse(toolName, toolID string, input map[string]interface{}) []types.LlmStreamEvent {
	stopReason := "tool_use"

	// Build partial JSON from input
	inputJSON := "{"
	first := true
	for k, v := range input {
		if !first {
			inputJSON += ","
		}
		first = false
		switch val := v.(type) {
		case string:
			inputJSON += `"` + k + `":"` + val + `"`
		default:
			inputJSON += `"` + k + `":` + formatValue(val)
		}
	}
	inputJSON += "}"

	return []types.LlmStreamEvent{
		{
			Type: "message_start",
			MessageInfo: &types.LlmStreamMessageInfo{
				ID:    "msg_test_tool",
				Model: "mock-model",
				Usage: types.LlmUsage{InputTokens: 10, OutputTokens: 0},
			},
		},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type: "tool_use",
				ID:   toolID,
				Name: toolName,
			},
		},
		{
			Type:       "content_block_delta",
			BlockIndex: 0,
			Delta: &types.LlmStreamDelta{
				Type:        "input_json_delta",
				PartialJSON: inputJSON,
			},
		},
		{
			Type:       "content_block_stop",
			BlockIndex: 0,
		},
		{
			Type: "message_delta",
			Delta: &types.LlmStreamDelta{
				Type:       "message_delta",
				StopReason: &stopReason,
			},
			DeltaUsage: &types.LlmUsage{OutputTokens: 10},
		},
		{
			Type: "message_stop",
		},
	}
}

// MultiTurnResponse returns a sequence that first makes a tool call, then
// (on the next Stream call) returns final text. Callers should call
// SetResponse twice: once with the tool call events, once with the text events.
func MultiTurnResponse(text1 string, toolName string, toolInput map[string]interface{}, text2 string) (toolCall []types.LlmStreamEvent, finalText []types.LlmStreamEvent) {
	toolCall = ToolCallResponse(toolName, "tool_"+toolName+"_001", toolInput)
	finalText = TextResponse(text2)
	return
}

func formatValue(v interface{}) string {
	switch val := v.(type) {
	case string:
		return `"` + val + `"`
	case int:
		return IntToStr(val)
	case float64:
		return floatToStr(val)
	case bool:
		if val {
			return "true"
		}
		return "false"
	default:
		return `"unknown"`
	}
}

// IntToStr converts an integer to a string without fmt dependency.
func IntToStr(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	digits := make([]byte, 0, 20)
	for n > 0 {
		digits = append(digits, byte('0'+n%10))
		n /= 10
	}
	// Reverse
	for i, j := 0, len(digits)-1; i < j; i, j = i+1, j-1 {
		digits[i], digits[j] = digits[j], digits[i]
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}

func floatToStr(f float64) string {
	// Simple conversion for test data
	n := int(f)
	return IntToStr(n)
}

// MockBackend implements backend.RunBackend for testing server and session manager.
type MockBackend struct {
	OnNorm  func(string, types.NormalizedEvent)
	OnExitF func(string, *int, *string, string)
	OnErrF  func(string, error)
	Started map[string]types.RunOptions
	mu      sync.Mutex
}

// NewMockBackend creates a MockBackend ready for use.
func NewMockBackend() *MockBackend {
	return &MockBackend{
		Started: make(map[string]types.RunOptions),
	}
}

func (m *MockBackend) StartRun(requestID string, options types.RunOptions) {
	m.mu.Lock()
	m.Started[requestID] = options
	m.mu.Unlock()
}

func (m *MockBackend) Cancel(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.Started[requestID]
	return ok
}

func (m *MockBackend) IsRunning(requestID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.Started[requestID]
	return ok
}

// WriteToStdin is a no-op stub satisfying the RunBackend interface.
func (m *MockBackend) WriteToStdin(_ string, _ interface{}) error {
	return nil
}

func (m *MockBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.OnNorm = fn
}

func (m *MockBackend) OnExit(fn func(string, *int, *string, string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.OnExitF = fn
}

func (m *MockBackend) OnError(fn func(string, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.OnErrF = fn
}

// EmitNormalized fires the normalized event callback (simulating backend output).
func (m *MockBackend) EmitNormalized(runID string, event types.NormalizedEvent) {
	m.mu.Lock()
	fn := m.OnNorm
	m.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

// EmitExit fires the exit callback.
func (m *MockBackend) EmitExit(runID string, code *int, signal *string, sessionID string) {
	m.mu.Lock()
	fn := m.OnExitF
	m.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

// EmitError fires the error callback.
func (m *MockBackend) EmitError(runID string, err error) {
	m.mu.Lock()
	fn := m.OnErrF
	m.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

// GetStarted returns the RunOptions for a given request ID.
func (m *MockBackend) GetStarted(requestID string) (types.RunOptions, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	opts, ok := m.Started[requestID]
	return opts, ok
}

// StartedKeys returns all started request IDs.
func (m *MockBackend) StartedKeys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.Started))
	for k := range m.Started {
		keys = append(keys, k)
	}
	return keys
}
