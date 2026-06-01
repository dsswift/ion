package session

import (
	"os"
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

func TestSessionMemory_ResetUpdateTracking(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)
	sm.lastUpdateTokens = 508494
	sm.lastUpdateTurn = 23

	sm.ResetUpdateTracking(50000, 5)

	sm.mu.RLock()
	defer sm.mu.RUnlock()
	if sm.lastUpdateTokens != 50000 {
		t.Errorf("lastUpdateTokens: got %d, want 50000", sm.lastUpdateTokens)
	}
	if sm.lastUpdateTurn != 5 {
		t.Errorf("lastUpdateTurn: got %d, want 5", sm.lastUpdateTurn)
	}
}

func TestSessionMemory_ResetUpdateTrackingEnablesGrowthAfterCompaction(t *testing.T) {
	// Simulates the "tokens went backwards" scenario: after compaction,
	// the token count drops below lastUpdateTokens. Without reset, the
	// growth threshold can never be satisfied.
	sm := NewSessionMemory("test-conv", t.TempDir(), &types.RunOptions{
		CompactMemoryUpdateMinTurns:  1,
		CompactMemoryUpdateThreshold: 5000,
	})
	sm.lastUpdateTokens = 200000 // pre-compaction peak
	sm.lastUpdateTurn = 10

	// Post-compaction: tokens dropped to 50000. Without reset,
	// growth = 50000 - 200000 = -150000, threshold never reached.
	sm.ResetUpdateTracking(50000, 10)

	// Now growth from 50000 to 56000 (6000 tokens) should exceed the 5000 threshold.
	conv := &conversation.Conversation{
		Messages: makeMessagesWithTokens(56000),
	}
	// Turn 12 is 2 turns after reset at turn 10, meeting the minTurns=1 threshold.
	// The actual OnTurnEnd will check token growth: 56000 - 50000 = 6000 > 5000.
	sm.mu.RLock()
	currentTokens := conversation.EstimateTokens(conv.Messages)
	growthMet := currentTokens-sm.lastUpdateTokens >= sm.updateThreshold
	sm.mu.RUnlock()

	if !growthMet {
		t.Errorf("growth threshold should be met after reset: tokens=%d baseline=%d threshold=%d",
			currentTokens, 50000, 5000)
	}
}

// makeMessagesWithTokens creates a slice of messages with approximately the given token count.
// Token estimation is ~4 chars per token, so we generate enough text to hit the target.
func makeMessagesWithTokens(targetTokens int) []types.LlmMessage {
	// Each char ≈ 0.25 tokens, so we need ~4 chars per token.
	textLen := targetTokens * 4
	text := strings.Repeat("a", textLen)
	return []types.LlmMessage{
		{Role: "user", Content: text},
	}
}

func TestSessionMemory_LoadMemoryParseFrontMatter(t *testing.T) {
	dir := t.TempDir()
	sm := NewSessionMemory("test-conv", dir, nil)

	// Write a memory file with front-matter.
	content := "---\nlastUpdateTokens: 508494\nlastUpdateTurn: 23\nlastSummarizedEntryID: a3f7b201\nupdatedAt: 2025-05-29T02:49:26Z\n---\nSession is deeply stuck with iOS theme issues."
	if err := os.WriteFile(sm.memoryFilePath(), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	sm2 := NewSessionMemory("test-conv", dir, nil)
	if !sm2.LoadMemory() {
		t.Fatal("LoadMemory should return true when file exists")
	}

	sm2.mu.RLock()
	defer sm2.mu.RUnlock()

	if sm2.lastUpdateTokens != 508494 {
		t.Errorf("lastUpdateTokens: got %d, want 508494", sm2.lastUpdateTokens)
	}
	if sm2.lastUpdateTurn != 23 {
		t.Errorf("lastUpdateTurn: got %d, want 23", sm2.lastUpdateTurn)
	}
	if sm2.lastSummarizedEntryID != "a3f7b201" {
		t.Errorf("lastSummarizedEntryID: got %q, want %q", sm2.lastSummarizedEntryID, "a3f7b201")
	}
	if sm2.memory != "Session is deeply stuck with iOS theme issues." {
		t.Errorf("memory: got %q, want %q", sm2.memory, "Session is deeply stuck with iOS theme issues.")
	}
}

func TestSessionMemory_LoadMemoryWithoutFrontMatter(t *testing.T) {
	dir := t.TempDir()
	sm := NewSessionMemory("test-conv", dir, nil)

	// Write a legacy memory file without front-matter.
	content := "Session is deeply stuck with iOS theme issues."
	if err := os.WriteFile(sm.memoryFilePath(), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	sm2 := NewSessionMemory("test-conv", dir, nil)
	if !sm2.LoadMemory() {
		t.Fatal("LoadMemory should return true when file exists")
	}

	sm2.mu.RLock()
	defer sm2.mu.RUnlock()

	if sm2.lastUpdateTokens != 0 {
		t.Errorf("lastUpdateTokens should be 0 for legacy files, got %d", sm2.lastUpdateTokens)
	}
	if sm2.lastSummarizedEntryID != "" {
		t.Errorf("lastSummarizedEntryID should be empty for legacy files, got %q", sm2.lastSummarizedEntryID)
	}
	if sm2.memory != content {
		t.Errorf("memory: got %q, want %q", sm2.memory, content)
	}
}

func TestSessionMemory_PersistMemoryWritesFrontMatter(t *testing.T) {
	dir := t.TempDir()
	sm := NewSessionMemory("test-conv", dir, nil)
	sm.Start()
	defer sm.Stop()

	sm.mu.Lock()
	sm.lastUpdateTokens = 12345
	sm.lastUpdateTurn = 7
	sm.lastSummarizedEntryID = "beef1234"
	sm.mu.Unlock()

	sm.persistMemory("test summary content")

	data, err := os.ReadFile(sm.memoryFilePath())
	if err != nil {
		t.Fatal(err)
	}

	raw := string(data)
	if !strings.HasPrefix(raw, "---\n") {
		t.Error("persisted file should start with front-matter delimiter")
	}
	if !strings.Contains(raw, "lastUpdateTokens: 12345") {
		t.Error("persisted file should contain lastUpdateTokens")
	}
	if !strings.Contains(raw, "lastUpdateTurn: 7") {
		t.Error("persisted file should contain lastUpdateTurn")
	}
	if !strings.Contains(raw, "lastSummarizedEntryID: beef1234") {
		t.Error("persisted file should contain lastSummarizedEntryID")
	}
	if !strings.Contains(raw, "updatedAt: ") {
		t.Error("persisted file should contain updatedAt timestamp")
	}
	if !strings.HasSuffix(raw, "test summary content") {
		t.Error("persisted file should end with the summary content")
	}
}

func TestSessionMemory_GetLastSummarizedEntryID(t *testing.T) {
	sm := NewSessionMemory("test-conv", t.TempDir(), nil)

	// Initially empty.
	if got := sm.GetLastSummarizedEntryID(); got != "" {
		t.Errorf("initial: got %q, want empty", got)
	}

	// Set it.
	sm.mu.Lock()
	sm.lastSummarizedEntryID = "abc12345"
	sm.mu.Unlock()

	if got := sm.GetLastSummarizedEntryID(); got != "abc12345" {
		t.Errorf("after set: got %q, want %q", got, "abc12345")
	}
}

func TestSessionMemory_PersistAndReloadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	sm := NewSessionMemory("test-conv", dir, nil)
	sm.Start()
	defer sm.Stop()

	// Set state and persist.
	sm.mu.Lock()
	sm.memory = "round trip content"
	sm.lastUpdateTokens = 99999
	sm.lastUpdateTurn = 42
	sm.lastSummarizedEntryID = "dead0000"
	sm.mu.Unlock()
	sm.persistMemory("round trip content")

	// Reload into a fresh instance.
	sm2 := NewSessionMemory("test-conv", dir, nil)
	if !sm2.LoadMemory() {
		t.Fatal("LoadMemory should succeed")
	}

	if sm2.GetMemory() != "round trip content" {
		t.Errorf("memory: got %q", sm2.GetMemory())
	}
	sm2.mu.RLock()
	defer sm2.mu.RUnlock()
	if sm2.lastUpdateTokens != 99999 {
		t.Errorf("lastUpdateTokens: got %d, want 99999", sm2.lastUpdateTokens)
	}
	if sm2.lastUpdateTurn != 42 {
		t.Errorf("lastUpdateTurn: got %d, want 42", sm2.lastUpdateTurn)
	}
	if sm2.lastSummarizedEntryID != "dead0000" {
		t.Errorf("lastSummarizedEntryID: got %q, want dead0000", sm2.lastSummarizedEntryID)
	}
}

func TestSessionMemory_LowerDefaultThresholds(t *testing.T) {
	// Verify the new default thresholds are lower than the old ones.
	if DefaultMemoryUpdateThreshold != 5000 {
		t.Errorf("DefaultMemoryUpdateThreshold: got %d, want 5000", DefaultMemoryUpdateThreshold)
	}
	if DefaultMemoryUpdateMinTurns != 3 {
		t.Errorf("DefaultMemoryUpdateMinTurns: got %d, want 3", DefaultMemoryUpdateMinTurns)
	}
}
