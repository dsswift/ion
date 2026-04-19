//go:build e2e

package e2e

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

type eventCollector struct {
	mu         sync.Mutex
	normalized []types.NormalizedEvent
	exits      []struct {
		code      *int
		signal    *string
		sessionID string
	}
	errors []error
}

func newEventCollector(b *backend.ApiBackend) *eventCollector {
	ec := &eventCollector{}
	b.OnNormalized(func(runID string, event types.NormalizedEvent) {
		ec.mu.Lock()
		ec.normalized = append(ec.normalized, event)
		ec.mu.Unlock()
	})
	b.OnExit(func(runID string, code *int, signal *string, sessionID string) {
		ec.mu.Lock()
		ec.exits = append(ec.exits, struct {
			code      *int
			signal    *string
			sessionID string
		}{code, signal, sessionID})
		ec.mu.Unlock()
	})
	b.OnError(func(runID string, err error) {
		ec.mu.Lock()
		ec.errors = append(ec.errors, err)
		ec.mu.Unlock()
	})
	return ec
}

func (ec *eventCollector) waitForExit(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ec.mu.Lock()
		n := len(ec.exits)
		ec.mu.Unlock()
		if n > 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("timed out waiting for exit event")
}

func (ec *eventCollector) getNormalized() []types.NormalizedEvent {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	out := make([]types.NormalizedEvent, len(ec.normalized))
	copy(out, ec.normalized)
	return out
}

// setupAnthropicProvider loads testconfig.json and registers an Anthropic provider
// pointing at the configured gateway. Skips test if no API key available.
func setupAnthropicProvider(t *testing.T) (model string) {
	t.Helper()
	providers.ResetRegistries()

	cfg, err := loadTestConfig()
	if err != nil {
		t.Skipf("testconfig.json not found: %v", err)
	}

	apiKey := cfg.Anthropic.ResolveAPIKey()
	if apiKey == "" {
		t.Skipf("no Anthropic API key (set %s or apiKey in testconfig.json)", cfg.Anthropic.APIKeyEnv)
	}

	p := providers.NewAnthropicProvider(&providers.ProviderOptions{
		APIKey:  apiKey,
		BaseURL: cfg.Anthropic.BaseURL,
	})
	providers.RegisterProvider(p)

	model = cfg.Anthropic.TestModel
	if model == "" {
		model = "claude-haiku-4-5-20251001"
	}

	// Register model info so cost tracking works
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:    "anthropic",
		ContextWindow: 200000,
		CostPer1kInput:  0.0008,
		CostPer1kOutput: 0.004,
	})

	return model
}

func TestLiveAnthropicSimplePrompt(t *testing.T) {
	model := setupAnthropicProvider(t)

	b := backend.NewApiBackend()
	ec := newEventCollector(b)

	b.StartRun("live-simple", types.RunOptions{
		Prompt:       "What is 2+2? Reply with just the number, nothing else.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 0.10,
		AllowedTools: []string{},
	})

	ec.waitForExit(t, 30*time.Second)

	events := ec.getNormalized()

	// Collect text chunks
	var fullText strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			fullText.WriteString(tc.Text)
		}
	}

	if !strings.Contains(fullText.String(), "4") {
		t.Errorf("expected response to contain '4', got: %q", fullText.String())
	}

	// Verify task_complete
	foundComplete := false
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			foundComplete = true
			if tc.CostUsd <= 0 {
				t.Errorf("expected cost > 0, got %f", tc.CostUsd)
			}
			if tc.NumTurns < 1 {
				t.Errorf("expected at least 1 turn, got %d", tc.NumTurns)
			}
		}
	}
	if !foundComplete {
		t.Error("did not receive task_complete event")
	}
}

func TestLiveAnthropicToolUse(t *testing.T) {
	model := setupAnthropicProvider(t)

	tmpDir := t.TempDir()
	testFile := tmpDir + "/test.txt"
	os.WriteFile(testFile, []byte("secret content: 42\n"), 0644)

	b := backend.NewApiBackend()
	ec := newEventCollector(b)

	b.StartRun("live-tool", types.RunOptions{
		Prompt:       "Read the file at " + testFile + " and tell me what the secret content is. Reply with just the number.",
		Model:        model,
		MaxTurns:     5,
		MaxBudgetUsd: 0.50,
		ProjectPath:  tmpDir,
	})

	ec.waitForExit(t, 60*time.Second)

	events := ec.getNormalized()

	// Should have a tool_call for Read
	foundToolCall := false
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.ToolCallEvent); ok {
			if tc.ToolName == "Read" {
				foundToolCall = true
			}
		}
	}
	if !foundToolCall {
		t.Error("expected a Read tool call")
	}

	// Response should mention 42
	var fullText strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			fullText.WriteString(tc.Text)
		}
	}
	if !strings.Contains(fullText.String(), "42") {
		t.Errorf("expected response to contain '42', got: %q", fullText.String())
	}
}

func TestLiveAnthropicStreaming(t *testing.T) {
	model := setupAnthropicProvider(t)

	provider := providers.GetProvider("anthropic")
	if provider == nil {
		t.Fatal("anthropic provider not registered after setup")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	events, errc := provider.Stream(ctx, types.LlmStreamOptions{
		Model:  model,
		System: "Reply concisely.",
		Messages: []types.LlmMessage{
			{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "Say 'test' and nothing else."}}},
		},
		MaxTokens: 100,
	})

	var eventTypes []string
	for ev := range events {
		eventTypes = append(eventTypes, ev.Type)
	}

	if err := <-errc; err != nil {
		t.Fatalf("stream error: %v", err)
	}

	if len(eventTypes) == 0 {
		t.Fatal("no events received")
	}
	if eventTypes[0] != "message_start" {
		t.Errorf("first event should be message_start, got %q", eventTypes[0])
	}

	last := eventTypes[len(eventTypes)-1]
	if last != "message_stop" && last != "message_delta" {
		t.Errorf("last event should be message_stop or message_delta, got %q", last)
	}
}
