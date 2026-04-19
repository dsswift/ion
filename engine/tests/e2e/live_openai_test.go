//go:build e2e

package e2e

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// setupOpenAIProvider loads testconfig.json and registers an OpenAI provider.
// Skips test if no API key available.
func setupOpenAIProvider(t *testing.T) (model string) {
	t.Helper()
	providers.ResetRegistries()

	cfg, err := loadTestConfig()
	if err != nil {
		t.Skipf("testconfig.json not found: %v", err)
	}

	apiKey := cfg.OpenAI.ResolveAPIKey()
	if apiKey == "" {
		t.Skipf("no OpenAI API key (set %s or apiKey in testconfig.json)", cfg.OpenAI.APIKeyEnv)
	}

	opts := &providers.ProviderOptions{
		APIKey: apiKey,
	}
	if cfg.OpenAI.BaseURL != "" {
		opts.BaseURL = cfg.OpenAI.BaseURL
	}

	p := providers.NewOpenAIProvider(opts)
	providers.RegisterProvider(p)

	model = cfg.OpenAI.TestModel
	if model == "" {
		model = "gpt-4.1-nano"
	}

	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:      "openai",
		ContextWindow:   1047576,
		CostPer1kInput:  0.0001,
		CostPer1kOutput: 0.0004,
		SupportsImages:  true,
	})

	return model
}

func TestLiveOpenAISimplePrompt(t *testing.T) {
	model := setupOpenAIProvider(t)

	b := backend.NewApiBackend()
	ec := newEventCollector(b)

	b.StartRun("live-openai-simple", types.RunOptions{
		Prompt:       "What is 3+3? Reply with just the number, nothing else.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 0.10,
		AllowedTools: []string{},
	})

	ec.waitForExit(t, 30*time.Second)

	events := ec.getNormalized()

	var fullText strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			fullText.WriteString(tc.Text)
		}
	}

	if !strings.Contains(fullText.String(), "6") {
		t.Errorf("expected response to contain '6', got: %q", fullText.String())
	}

	foundComplete := false
	for _, ev := range events {
		if _, ok := ev.Data.(*types.TaskCompleteEvent); ok {
			foundComplete = true
		}
	}
	if !foundComplete {
		t.Error("did not receive task_complete event")
	}
}

// setupOpenAIGatewayProvider registers an OpenAI-compatible provider pointing
// at the AI gateway (x-api-key auth, gateway base URL).
func setupOpenAIGatewayProvider(t *testing.T) (model string) {
	t.Helper()
	providers.ResetRegistries()

	cfg, err := loadTestConfig()
	if err != nil {
		t.Skipf("testconfig.json not found: %v", err)
	}

	gw := cfg.OpenAIGateway
	if gw.BaseURL == "" {
		t.Skip("openaiGateway.baseURL not configured")
	}

	apiKey := gw.ResolveAPIKey()
	if apiKey == "" {
		t.Skipf("no gateway API key (set %s or apiKey in testconfig.json)", gw.APIKeyEnv)
	}

	p := providers.NewOpenAIProvider(&providers.ProviderOptions{
		APIKey:     apiKey,
		BaseURL:    gw.BaseURL,
		AuthHeader: "x-api-key",
	})
	providers.RegisterProvider(p)

	model = gw.TestModel
	if model == "" {
		model = "gpt-5.2"
	}

	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:      "openai",
		ContextWindow:   1047576,
		CostPer1kInput:  0.002,
		CostPer1kOutput: 0.008,
	})

	return model
}

func TestLiveOpenAIGatewaySimplePrompt(t *testing.T) {
	model := setupOpenAIGatewayProvider(t)

	b := backend.NewApiBackend()
	ec := newEventCollector(b)

	b.StartRun("live-gw-openai", types.RunOptions{
		Prompt:       "What is 5+5? Reply with just the number, nothing else.",
		Model:        model,
		MaxTurns:     1,
		MaxBudgetUsd: 1.00,
		AllowedTools: []string{},
	})

	ec.waitForExit(t, 60*time.Second)

	events := ec.getNormalized()

	var fullText strings.Builder
	for _, ev := range events {
		if tc, ok := ev.Data.(*types.TextChunkEvent); ok {
			fullText.WriteString(tc.Text)
		}
	}

	if !strings.Contains(fullText.String(), "10") {
		t.Errorf("expected '10', got: %q", fullText.String())
	}
}

func TestLiveOpenAIGatewayStreaming(t *testing.T) {
	model := setupOpenAIGatewayProvider(t)

	provider := providers.GetProvider("openai")
	if provider == nil {
		t.Fatal("openai provider not registered")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	events, errc := provider.Stream(ctx, types.LlmStreamOptions{
		Model:     model,
		System:    "Reply concisely.",
		Messages:  []types.LlmMessage{{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "Say 'gateway test passed' and nothing else."}}}},
		MaxTokens: 100,
	})

	var eventTypes []string
	var text strings.Builder
	for ev := range events {
		eventTypes = append(eventTypes, ev.Type)
		if ev.Delta != nil && ev.Delta.Text != "" {
			text.WriteString(ev.Delta.Text)
		}
	}

	if err := <-errc; err != nil {
		t.Fatalf("stream error: %v", err)
	}

	if len(eventTypes) == 0 {
		t.Fatal("no events received")
	}
	if eventTypes[0] != "message_start" {
		t.Errorf("first event: want message_start, got %q", eventTypes[0])
	}

	lower := strings.ToLower(text.String())
	if !strings.Contains(lower, "gateway") && !strings.Contains(lower, "test") && !strings.Contains(lower, "passed") {
		t.Logf("response: %q (model may rephrase, not a hard failure)", text.String())
	}
}

func TestLiveOpenAIStreamTranslation(t *testing.T) {
	model := setupOpenAIProvider(t)

	provider := providers.GetProvider("openai")
	if provider == nil {
		t.Fatal("openai provider not registered after setup")
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

	// OpenAI translates to canonical format -- message_start first
	if eventTypes[0] != "message_start" {
		t.Errorf("first event should be message_start, got %q", eventTypes[0])
	}

	// Should have content_block_delta events
	foundDelta := false
	for _, et := range eventTypes {
		if et == "content_block_delta" {
			foundDelta = true
			break
		}
	}
	if !foundDelta {
		t.Errorf("expected content_block_delta events, got types: %v", eventTypes)
	}
}
