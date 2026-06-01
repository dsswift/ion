package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestSessionMemory_GetSetMemory(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)

	if got := sm.GetMemory(); got != "" {
		t.Errorf("initial memory should be empty, got %q", got)
	}

	sm.SetMemory("test summary")
	if got := sm.GetMemory(); got != "test summary" {
		t.Errorf("after set: got %q, want %q", got, "test summary")
	}
}

func TestSessionMemory_LoadMemory(t *testing.T) {
	dir := t.TempDir()
	sm := NewSessionMemory("test-conv", dir, nil)

	// No file yet — should return false.
	if sm.LoadMemory() {
		t.Error("LoadMemory should return false when no file exists")
	}

	// Write a memory file, then load it.
	sm.SetMemory("persisted summary")
	sm2 := NewSessionMemory("test-conv", dir, nil)
	if !sm2.LoadMemory() {
		t.Error("LoadMemory should return true when file exists")
	}
	if got := sm2.GetMemory(); got != "persisted summary" {
		t.Errorf("loaded memory: got %q, want %q", got, "persisted summary")
	}
}

func TestSessionMemory_Debouncing(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)
	sm.lastUpdateTurn = 0
	sm.lastUpdateTokens = 0

	// Create a small conversation — should not trigger update (below threshold).
	conv := &conversation.Conversation{
		Messages: []types.LlmMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "hi"},
		},
	}

	// Turn 1 — below minTurns threshold (default 5).
	sm.OnTurnEnd(conv, 1)
	sm.wg.Wait()
	if sm.GetMemory() != "" {
		t.Error("should not update at turn 1 (below minTurns)")
	}
}

func TestSessionMemory_ConfigOverrides(t *testing.T) {
	opts := &types.RunOptions{
		CompactMemoryModel:           "custom-model",
		CompactMemoryMaxTokens:       2048,
		CompactMemoryUpdateThreshold: 5000,
		CompactMemoryUpdateMinTurns:  2,
	}
	sm := NewSessionMemory("test-conv", t.TempDir(), opts)

	if sm.model != "custom-model" {
		t.Errorf("model: got %q, want %q", sm.model, "custom-model")
	}
	if sm.maxTokens != 2048 {
		t.Errorf("maxTokens: got %d, want %d", sm.maxTokens, 2048)
	}
	if sm.updateThreshold != 5000 {
		t.Errorf("updateThreshold: got %d, want %d", sm.updateThreshold, 5000)
	}
	if sm.updateMinTurns != 2 {
		t.Errorf("updateMinTurns: got %d, want %d", sm.updateMinTurns, 2)
	}
}

func TestSessionMemory_InjectMemoryIntoSystemPrompt(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)

	// Empty memory — should not inject.
	opts := &types.RunOptions{}
	sm.InjectMemoryIntoSystemPrompt(opts)
	if opts.AppendSystemPrompt != "" {
		t.Error("empty memory should not inject anything")
	}

	// Non-empty memory — should inject.
	sm.SetMemory("important context here")
	sm.InjectMemoryIntoSystemPrompt(opts)
	if opts.AppendSystemPrompt == "" {
		t.Error("non-empty memory should inject into system prompt")
	}
	if !strings.Contains(opts.AppendSystemPrompt, "important context here") {
		t.Error("injected prompt should contain the memory content")
	}
	if !strings.Contains(opts.AppendSystemPrompt, "Session Memory") {
		t.Error("injected prompt should contain the section header")
	}
}

func TestSessionMemory_InjectMemoryAppends(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)
	sm.SetMemory("some memory")

	opts := &types.RunOptions{
		AppendSystemPrompt: "existing prompt content",
	}
	sm.InjectMemoryIntoSystemPrompt(opts)

	if !strings.HasPrefix(opts.AppendSystemPrompt, "existing prompt content") {
		t.Error("injection should preserve existing AppendSystemPrompt")
	}
	if !strings.Contains(opts.AppendSystemPrompt, "some memory") {
		t.Error("injection should append memory content")
	}
}

func TestSessionMemory_StartStop(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)
	sm.Start()
	// Stop should not panic or hang.
	sm.Stop()
	// Double-stop should also be safe.
	sm.Stop()
}

func TestSessionMemory_MemoryFilePath(t *testing.T) {
	dir := t.TempDir()
	sm := NewSessionMemory("my-conv-123", dir, nil)
	path := sm.memoryFilePath()
	if !strings.HasSuffix(path, "my-conv-123.memory.md") {
		t.Errorf("memoryFilePath: got %q, expected suffix my-conv-123.memory.md", path)
	}
}

func TestSessionMemory_DebounceTurnsOnly(t *testing.T) {
	// Enough turns but not enough token growth — should not trigger.
	sm := NewSessionMemory("test-conv", t.TempDir(), &types.RunOptions{
		CompactMemoryUpdateMinTurns:  1,
		CompactMemoryUpdateThreshold: 999999, // very high threshold
	})
	sm.lastUpdateTurn = 0
	sm.lastUpdateTokens = 0

	conv := &conversation.Conversation{
		Messages: []types.LlmMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "hi there"},
		},
	}

	sm.OnTurnEnd(conv, 5)
	sm.wg.Wait()
	if sm.GetMemory() != "" {
		t.Error("should not update when token growth below threshold")
	}
}

func TestSessionMemory_StopCancelsContext(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)
	sm.Start()

	// After Start, the context should not be cancelled.
	if sm.ctx.Err() != nil {
		t.Errorf("after Start: ctx.Err() should be nil, got %v", sm.ctx.Err())
	}

	sm.Stop()

	// After Stop, the context should be cancelled.
	if sm.ctx.Err() == nil {
		t.Error("after Stop: ctx.Err() should be non-nil (context cancelled)")
	}
}

func TestSessionMemory_MemoryEnabledConfigGate(t *testing.T) {
	// Helper to create a *bool.
	boolPtr := func(b bool) *bool { return &b }

	tests := []struct {
		name           string
		memoryEnabled  *bool
		wantDisabled   bool
	}{
		{
			name:          "nil (default) — memory enabled",
			memoryEnabled: nil,
			wantDisabled:  false,
		},
		{
			name:          "explicit true — memory enabled",
			memoryEnabled: boolPtr(true),
			wantDisabled:  false,
		},
		{
			name:          "explicit false — memory disabled",
			memoryEnabled: boolPtr(false),
			wantDisabled:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cfg *types.EngineRuntimeConfig
			if tt.memoryEnabled != nil {
				cfg = &types.EngineRuntimeConfig{
					Compaction: &types.CompactionConfig{
						MemoryEnabled: tt.memoryEnabled,
					},
				}
			}

			// Reproduce the gate expression used in start_session.go and event_translation.go.
			memoryDisabled := cfg != nil && cfg.Compaction != nil &&
				cfg.Compaction.MemoryEnabled != nil && !*cfg.Compaction.MemoryEnabled

			if memoryDisabled != tt.wantDisabled {
				t.Errorf("memoryDisabled = %v, want %v", memoryDisabled, tt.wantDisabled)
			}
		})
	}
}
