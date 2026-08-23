package backend

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestRunLoopAutoCompactsAtModelAwareLimitBeforeProviderCall(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const model = "ctxwin-auto-compact-model"
	mock := setupTestProviderModel(model, [][]types.LlmStreamEvent{
		textResponse("continued after compaction", 1_000, 20),
	})
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:      testProviderID,
		ContextWindow:   1_000_000,
		MaxOutputTokens: 128_000,
	})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	convID := "ctxwin-auto-compact-conversation"
	conv := conversation.CreateConversation(convID, "", model)
	for i := 0; i < 4; i++ {
		conversation.AddUserMessage(conv, "prior user turn")
		usage := types.LlmUsage{}
		if i == 3 {
			usage.InputTokens = 911_135
		}
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "prior assistant turn"}}, usage)
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conversation: %v", err)
	}

	b := NewApiBackend()
	events := collectEvents(b, "ctxwin-auto-compact-run")
	b.StartRun("ctxwin-auto-compact-run", types.RunOptions{
		Prompt:                "resume",
		ProjectPath:           t.TempDir(),
		Model:                 model,
		ConversationID:        convID,
		CompactSummaryEnabled: boolPtr(false),
		EarlyStopEnabled:      testEarlyStopDisabled(),
	})
	if !waitForExit(events, 5*time.Second) {
		t.Fatal("timed out waiting for run exit")
	}

	mock.mu.Lock()
	requests := append([]types.LlmStreamOptions(nil), mock.requests...)
	mock.mu.Unlock()
	if len(requests) != 1 {
		t.Fatalf("provider request count = %d, want 1", len(requests))
	}
	for _, msg := range requests[0].Messages {
		if conversation.IsCompactBoundary(msg) {
			return
		}
	}
	t.Fatal("provider request did not contain the auto-compaction boundary")
}

func boolPtr(value bool) *bool { return &value }

func TestRunLoopContextCapacityUsesModelOutputReserve(t *testing.T) {
	const model = "ctxwin-large-output-model"
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:      "openai",
		ContextWindow:   1_000_000,
		MaxOutputTokens: 128_000,
	})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	capacity := resolveRunContextCapacity(model, 0)
	if got, want := capacity.AutoCompactLimit(0), 859_000; got != want {
		t.Fatalf("run-loop auto compact limit = %d, want %d", got, want)
	}
	if legacy := conversation.AutoCompactTokenLimit(capacity.RawLimit, 0); legacy == capacity.AutoCompactLimit(0) {
		t.Fatalf("test setup invalid: compatibility limit %d must differ from model-aware limit %d", legacy, capacity.AutoCompactLimit(0))
	}
}

// TestResolveContextWindow pins the zero-window guard. A registry entry with
// ContextWindow == 0 must NOT overwrite the engine default with 0 (which would
// collapse compaction to a 0-token budget every turn). The > 0 guard lives at
// the resolution site so the clamped value flows into the compaction math, not
// only into GetContextUsage's internal clamp.
func TestResolveContextWindow(t *testing.T) {
	// Registry entry with a zero context window (a catalog gap).
	providers.RegisterModel("ctxwin-zero-model", types.ModelInfo{
		ProviderID:    "openai",
		ContextWindow: 0,
	})
	// Registry entry with a usable positive window.
	providers.RegisterModel("ctxwin-positive-model", types.ModelInfo{
		ProviderID:    "openai",
		ContextWindow: 128000,
	})
	// "ctxwin-unknown-model" is deliberately NOT registered.

	tests := []struct {
		name  string
		model string
		want  int
	}{
		{"zero-window registry entry falls back to default", "ctxwin-zero-model", conversation.DefaultContext},
		{"positive-window registry entry is used", "ctxwin-positive-model", 128000},
		{"unknown model falls back to default", "ctxwin-unknown-model", conversation.DefaultContext},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveContextWindow(tt.model)
			if got != tt.want {
				t.Errorf("resolveContextWindow(%q) = %d, want %d", tt.model, got, tt.want)
			}
		})
	}
}

// TestResolveContextWindow_SonnetAndOpus48 pins the catalog values updated by
// the models.json fix so a future accidental regression is caught immediately.
func TestResolveContextWindow_SonnetAndOpus48(t *testing.T) {
	// claude-sonnet-4-6 was updated from 200k to 1M in the catalog fix.
	// claude-opus-4-8 was added with 1M window.
	cases := []struct {
		model string
		want  int
	}{
		{"claude-sonnet-4-6", 1_000_000},
		{"claude-opus-4-8", 1_000_000},
		{"claude-opus-4-6", 1_000_000}, // already correct; guard against accidental revert
		{"claude-opus-4-7", 1_000_000}, // same
	}
	for _, tc := range cases {
		t.Run(tc.model, func(t *testing.T) {
			got := resolveContextWindow(tc.model)
			if got != tc.want {
				t.Errorf("resolveContextWindow(%q) = %d, want %d", tc.model, got, tc.want)
			}
		})
	}
}
