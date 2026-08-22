package titling

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

type recordingProvider struct {
	id string

	mu     sync.Mutex
	opts   types.LlmStreamOptions
	events []types.LlmStreamEvent
}

func (p *recordingProvider) ID() string { return p.id }

func (p *recordingProvider) CountTokens(_ context.Context, _ providers.CountTokensRequest) (int, error) {
	return 0, providers.ErrCountUnsupported
}

func (p *recordingProvider) Stream(_ context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, len(p.events))
	errc := make(chan error, 1)

	p.mu.Lock()
	p.opts = opts
	p.mu.Unlock()

	for _, event := range p.events {
		events <- event
	}
	close(events)
	close(errc)
	return events, errc
}

func (p *recordingProvider) options() types.LlmStreamOptions {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.opts
}

func registerTitleProvider(t *testing.T, events []types.LlmStreamEvent) (*recordingProvider, string) {
	t.Helper()

	model := "title-test-model-" + t.Name()
	providerID := "title-test-provider-" + t.Name()
	provider := &recordingProvider{id: providerID, events: events}
	providers.RegisterProvider(provider)
	providers.RegisterModel(model, types.ModelInfo{ProviderID: providerID})
	t.Cleanup(func() {
		providers.UnregisterModel(model)
		providers.UnregisterProvider(providerID)
	})
	return provider, model
}

func withTitleModel(t *testing.T, model string) {
	t.Helper()

	prior := authResolver
	authResolver = nil
	t.Cleanup(func() { authResolver = prior })

	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".ion"), 0o700); err != nil {
		t.Fatalf("create test Ion directory: %v", err)
	}
	config := `{"tiers":{"fast":"` + model + `"}}`
	if err := os.WriteFile(filepath.Join(home, ".ion", "models.json"), []byte(config), 0o600); err != nil {
		t.Fatalf("write test models config: %v", err)
	}
}

func TestGenerateTitleDisablesReasoningAndExtractsVisibleText(t *testing.T) {
	stopReason := "end_turn"
	provider, model := registerTitleProvider(t, []types.LlmStreamEvent{
		{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "thinking_delta", Thinking: "brief reasoning"}},
		{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "Fix Auto Generated Titles"}},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}, DeltaUsage: &types.LlmUsage{OutputTokens: 32}},
	})
	withTitleModel(t, model)

	title, err := GenerateTitle(context.Background(), "auto titles do not work")
	if err != nil {
		t.Fatalf("GenerateTitle() error = %v", err)
	}
	if title != "Fix Auto Generated Titles" {
		t.Errorf("GenerateTitle() = %q, want visible title after reasoning", title)
	}
	if got := provider.options().MaxTokens; got != titleMaxTokens {
		t.Errorf("title MaxTokens = %d, want bounded title budget %d", got, titleMaxTokens)
	}
	if thinking := provider.options().Thinking; thinking == nil || thinking.Enabled {
		t.Errorf("title Thinking = %#v, want explicitly disabled", thinking)
	}
	if !provider.options().DisableThinking {
		t.Error("title DisableThinking = false, want true")
	}
}

func TestGenerateTitleRejectsIncompleteOutput(t *testing.T) {
	for _, stopReason := range []string{"max_tokens", "length"} {
		t.Run(stopReason, func(t *testing.T) {
			_, model := registerTitleProvider(t, []types.LlmStreamEvent{
				{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "Partial title"}},
				{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}, DeltaUsage: &types.LlmUsage{OutputTokens: 20}},
			})
			withTitleModel(t, model)

			title, err := GenerateTitle(context.Background(), "title that should not apply")
			if err != nil {
				t.Fatalf("GenerateTitle() error = %v", err)
			}
			if title != "" {
				t.Errorf("GenerateTitle() = %q, want empty title from incomplete output", title)
			}
		})
	}
}

func TestGenerateTitleAcceptsMultibyteOutputWithinCharacterLimit(t *testing.T) {
	stopReason := "end_turn"
	const title = "日本語タイトル日本語タイトル日本語タイトル"
	_, model := registerTitleProvider(t, []types.LlmStreamEvent{
		{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: title}},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}},
	})
	withTitleModel(t, model)

	got, err := GenerateTitle(context.Background(), "multibyte title test")
	if err != nil {
		t.Fatalf("GenerateTitle() error = %v", err)
	}
	if got != title {
		t.Errorf("GenerateTitle() = %q, want %q", got, title)
	}
}

// The sanity bound rejects prose, not a compliant title. A model that returns a
// sentence or an answer to the message must not become the conversation's name.
func TestGenerateTitleRejectsOversizedOutput(t *testing.T) {
	stopReason := "end_turn"
	// Comfortably past the bound: a refusal/explanation rather than a title.
	oversized := "This message appears to be asking about configuration options, and the answer depends on which provider you have selected"
	if utf8.RuneCountInString(oversized) <= titleMaxChars {
		t.Fatalf("fixture must exceed the bound to test rejection: %d <= %d", utf8.RuneCountInString(oversized), titleMaxChars)
	}
	_, model := registerTitleProvider(t, []types.LlmStreamEvent{
		{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: oversized}},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}},
	})
	withTitleModel(t, model)

	title, err := GenerateTitle(context.Background(), "title that should remain the client fallback")
	if err != nil {
		t.Fatalf("GenerateTitle() error = %v", err)
	}
	if title != "" {
		t.Errorf("GenerateTitle() = %q, want empty title from oversized output", title)
	}
}

/*
The system prompt asks for a 3-8 word title, so the sanity bound must not
reject one. The bound was 40 runes while eight ordinary words plus separators
run past 55, so a model that complied EXACTLY was rejected as "too long" and
the caller silently kept its fallback — the reported "regenerate title does
nothing" defect, after hydration was already fixed.

Regression direction: lowering titleMaxChars back under the prompt's own
8-word request turns this red.
*/
func TestGenerateTitleAcceptsTheEightWordTitleItAsksFor(t *testing.T) {
	stopReason := "end_turn"
	// A realistic upper-bound answer to the prompt's own "3-8 word" request.
	const title = "Desktop Inbox Regenerate Title Command Silently Failing Again"
	if words := len(strings.Fields(title)); words != 8 {
		t.Fatalf("fixture must be the prompt's 8-word upper bound, got %d words", words)
	}
	_, model := registerTitleProvider(t, []types.LlmStreamEvent{
		{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: title}},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}},
	})
	withTitleModel(t, model)

	got, err := GenerateTitle(context.Background(), "a conversation about the inbox retitle command")
	if err != nil {
		t.Fatalf("GenerateTitle() error = %v", err)
	}
	if got != title {
		t.Errorf("GenerateTitle() = %q, want the compliant 8-word title %q", got, title)
	}
}

// The input bound is in runes. Byte-slicing a multibyte prompt cut a character
// in half and sent invalid UTF-8 upstream.
func TestGenerateTitleTruncatesLongInputOnRuneBoundaries(t *testing.T) {
	stopReason := "end_turn"
	provider, model := registerTitleProvider(t, []types.LlmStreamEvent{
		{Type: "content_block_delta", Delta: &types.LlmStreamDelta{Type: "text_delta", Text: "Multibyte Input Title"}},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: &stopReason}},
	})
	withTitleModel(t, model)

	// Every rune is 3 bytes, so a byte-slice at maxInputChars lands mid-rune.
	oversized := strings.Repeat("日", maxInputChars+500)
	if _, err := GenerateTitle(context.Background(), oversized); err != nil {
		t.Fatalf("GenerateTitle() error = %v", err)
	}

	sent, ok := provider.options().Messages[0].Content.(string)
	if !ok {
		t.Fatalf("prompt content is not a string: %T", provider.options().Messages[0].Content)
	}
	if !utf8.ValidString(sent) {
		t.Error("truncated prompt is not valid UTF-8; input was sliced mid-rune")
	}
	if strings.ContainsRune(sent, '\uFFFD') {
		t.Error("truncated prompt contains a replacement char; input was sliced mid-rune")
	}
}
