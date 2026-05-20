package conversation

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestEstimateTokens(t *testing.T) {
	tests := []struct {
		name    string
		content any
		wantMin int
		wantMax int
	}{
		{
			name:    "short string",
			content: "hello",
			wantMin: 1,
			wantMax: 5,
		},
		{
			name:    "longer string",
			content: "The quick brown fox jumps over the lazy dog.",
			wantMin: 5,
			wantMax: 20,
		},
		{
			name:    "content blocks",
			content: []types.LlmContentBlock{{Type: "text", Text: "hello world"}},
			wantMin: 5,
			wantMax: 30,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EstimateTokens(tt.content)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("EstimateTokens = %d, want [%d, %d]", got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestGetContextUsage(t *testing.T) {
	t.Run("reported tokens", func(t *testing.T) {
		conv := CreateConversation("cu-1", "", "claude-3")
		conv.LastInputTokens = 60000

		info := GetContextUsage(conv, 200000)
		if info.Estimated {
			t.Error("should not be estimated when tokens are reported")
		}
		if info.Tokens != 60000 {
			t.Errorf("Tokens = %d, want 60000", info.Tokens)
		}
		if info.Percent != 30 {
			t.Errorf("Percent = %d, want 30", info.Percent)
		}
		if info.Limit != 200000 {
			t.Errorf("Limit = %d", info.Limit)
		}
	})

	t.Run("estimated tokens", func(t *testing.T) {
		conv := CreateConversation("cu-2", "", "claude-3")
		AddUserMessage(conv, "hello world this is a test message")
		info := GetContextUsage(conv, 0)
		if !info.Estimated {
			t.Error("should be estimated when no reported tokens")
		}
		if info.Limit != DefaultContext {
			t.Errorf("Limit = %d, want %d", info.Limit, DefaultContext)
		}
	})
}

func TestCompact(t *testing.T) {
	conv := CreateConversation("compact-test", "", "claude-3")

	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	Compact(conv, 3)
	// Should keep from the user message where pairs==3 to the end
	if len(conv.Messages) > 7 {
		t.Errorf("expected at most 7 messages after compact(3), got %d", len(conv.Messages))
	}
	if len(conv.Messages) < 5 {
		t.Errorf("expected at least 5 messages after compact(3), got %d", len(conv.Messages))
	}
}

func TestCompactNoOp(t *testing.T) {
	conv := CreateConversation("compact-noop", "", "claude-3")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "hello"})

	Compact(conv, 10)
	if len(conv.Messages) != 2 {
		t.Errorf("expected 2 messages (no compaction needed), got %d", len(conv.Messages))
	}
}

func TestMicroCompact(t *testing.T) {
	conv := CreateConversation("micro-test", "", "claude-3")

	longContent := strings.Repeat("x", 200)

	// Old turn with long tool result
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn (should not be cleared)
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_2", Content: longContent},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "also done"})

	cleared := MicroCompact(conv, 1)
	if cleared != 1 {
		t.Errorf("cleared = %d, want 1", cleared)
	}

	// Check old message was cleared
	oldBlocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	if oldBlocks[0].Content != "[cleared]" {
		t.Errorf("old tool result should be [cleared], got %v", oldBlocks[0].Content)
	}

	// Check recent message was NOT cleared
	recentBlocks := conv.Messages[2].Content.([]types.LlmContentBlock)
	if recentBlocks[0].Content == "[cleared]" {
		t.Error("recent tool result should not be cleared")
	}
}

func TestCompactWithSummary(t *testing.T) {
	conv := CreateConversation("summary-test", "", "claude-3")

	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "question"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "answer"})
	}

	summarize := func(text string) (string, error) {
		return "conversation about questions and answers", nil
	}

	err := CompactWithSummary(conv, summarize, 3)
	if err != nil {
		t.Fatal(err)
	}

	if conv.Messages[0].Role != "user" {
		t.Errorf("first message role = %q, want user", conv.Messages[0].Role)
	}
	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content to be []LlmContentBlock")
	}
	if !strings.Contains(blocks[0].Text, "Previous conversation summary") {
		t.Errorf("summary message missing expected text, got %q", blocks[0].Text)
	}
}

func TestMicroCompact_TextOnly(t *testing.T) {
	conv := CreateConversation("micro-text", "", "claude-3")

	// Text-only messages: MicroCompact should not touch them
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	cleared := MicroCompact(conv, 3)
	if cleared != 0 {
		t.Fatalf("expected 0 cleared (no tool results), got %d", cleared)
	}
}

func TestMicroCompact_ShortToolResults(t *testing.T) {
	conv := CreateConversation("micro-short", "", "claude-3")

	// Tool results under 100 chars should not be cleared
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: "short result"},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 0 {
		t.Fatalf("expected 0 cleared (short content), got %d", cleared)
	}
}

func TestMicroCompact_MixedBlocks(t *testing.T) {
	conv := CreateConversation("micro-mixed", "", "claude-3")

	longContent := strings.Repeat("x", 200)

	// User message with both text and tool_result blocks
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "text", Text: "please read this"},
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 1 {
		t.Fatalf("expected 1 cleared, got %d", cleared)
	}

	// Text block should be preserved
	blocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[0].Text != "please read this" {
		t.Error("text block should not be cleared")
	}
	if blocks[1].Content != "[cleared]" {
		t.Error("tool_result should be cleared")
	}
}

func TestMicroCompact_MultipleToolResults(t *testing.T) {
	conv := CreateConversation("micro-multi", "", "claude-3")

	longContent := strings.Repeat("y", 200)

	// Old turn with multiple tool results
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
			{Type: "tool_result", ToolUseID: "tu_2", Content: longContent},
			{Type: "tool_result", ToolUseID: "tu_3", Content: "short"},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 2 {
		t.Fatalf("expected 2 cleared (two long tool results), got %d", cleared)
	}
}

// --- JSONL: large conversations ---

func TestEstimateTokens_EmptyString(t *testing.T) {
	result := EstimateTokens("")
	if result != 0 {
		t.Fatalf("expected 0 for empty string, got %d", result)
	}
}

func TestEstimateTokens_LongString(t *testing.T) {
	text := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 100)
	result := EstimateTokens(text)
	if result < 100 || result > 5000 {
		t.Fatalf("estimate = %d, expected 100-5000 range", result)
	}
}

func TestEstimateTokens_ToolUseBlocks(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", ID: "tu_1", Name: "Read", Input: map[string]any{"file_path": "/src/main.go"}},
	}
	result := EstimateTokens(blocks)
	if result <= 0 {
		t.Fatalf("expected positive estimate for tool_use block, got %d", result)
	}
}

func TestEstimateTokens_ImageBlock(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: strings.Repeat("A", 1000)}},
	}
	result := EstimateTokens(blocks)
	if result <= 0 {
		t.Fatalf("expected positive estimate for image block, got %d", result)
	}
}

func TestEstimateTokens_MessageArray(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: "hello world"},
		{Role: "assistant", Content: []types.LlmContentBlock{{Type: "text", Text: "hi there how are you"}}},
	}
	result := EstimateTokens(msgs)
	if result <= 0 {
		t.Fatalf("expected positive estimate, got %d", result)
	}
}

// --- Context usage ---

func TestGetContextUsage_PercentCap(t *testing.T) {
	conv := CreateConversation("cap-test", "", "claude-3")
	conv.LastInputTokens = 30000

	info := GetContextUsage(conv, 10000)
	if info.Percent != 100 {
		t.Errorf("expected capped at 100, got %d", info.Percent)
	}
}

func TestGetContextUsage_DefaultWindow(t *testing.T) {
	conv := CreateConversation("def-win", "", "claude-3")
	AddUserMessage(conv, "hello")

	info := GetContextUsage(conv, 0)
	if info.Limit != DefaultContext {
		t.Errorf("expected %d, got %d", DefaultContext, info.Limit)
	}
}

func TestGetContextUsage_NoReportedTokens_FallsBackToEstimate(t *testing.T) {
	conv := CreateConversation("zero", "", "claude-3")

	info := GetContextUsage(conv, 200000)
	// No reported tokens, so falls back to estimation of empty messages list
	if !info.Estimated {
		t.Error("expected estimated=true when no reported tokens")
	}
	if info.Limit != 200000 {
		t.Errorf("expected limit 200000, got %d", info.Limit)
	}
}

// --- Edge cases ---

func TestCompact_AllMessages(t *testing.T) {
	conv := CreateConversation("compact-all", "", "claude-3")
	for i := 0; i < 5; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	Compact(conv, 1)
	// Should keep at least last user+assistant pair
	if len(conv.Messages) < 2 {
		t.Fatalf("expected at least 2 messages after compact(1), got %d", len(conv.Messages))
	}
}

func TestCompact_DefaultKeepTurns(t *testing.T) {
	conv := CreateConversation("compact-default", "", "claude-3")
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	Compact(conv, 0) // 0 defaults to 10
	// Should keep roughly 10 turns
	if len(conv.Messages) > 21 {
		t.Errorf("expected at most ~21 messages, got %d", len(conv.Messages))
	}
}

func TestCompactWithSummary_NoOp(t *testing.T) {
	conv := CreateConversation("no-compact", "", "claude-3")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "hello"})

	called := false
	summarize := func(text string) (string, error) {
		called = true
		return "summary", nil
	}

	err := CompactWithSummary(conv, summarize, 10)
	if err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("summarize should not be called when messages < keepTurns")
	}
	if len(conv.Messages) != 2 {
		t.Fatalf("expected 2 messages unchanged, got %d", len(conv.Messages))
	}
}

func TestCompactWithSummary_SummarizeError_FallbackToTruncation(t *testing.T) {
	conv := CreateConversation("fail-summary", "", "claude-3")
	for i := 0; i < 15; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "question"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "answer"})
	}
	before := len(conv.Messages)

	failSummarize := func(text string) (string, error) {
		return "", fmt.Errorf("LLM unavailable")
	}

	err := CompactWithSummary(conv, failSummarize, 3)
	// Error is returned but fallback truncation still happens
	if err == nil {
		t.Fatal("expected error to be returned")
	}
	if len(conv.Messages) >= before {
		t.Fatalf("expected fewer messages after fallback truncation, got %d", len(conv.Messages))
	}

	// No summary prefix in first message
	first := conv.Messages[0]
	switch c := first.Content.(type) {
	case string:
		if strings.Contains(c, "Previous conversation summary") {
			t.Error("should not contain summary after error")
		}
	case []types.LlmContentBlock:
		if len(c) > 0 && strings.Contains(c[0].Text, "Previous conversation summary") {
			t.Error("should not contain summary after error")
		}
	}
}

// --- ForkConversation v2 ---

func TestCompactWithSummary_ReceivesDroppedMessageText(t *testing.T) {
	conv := CreateConversation("summary-text", "", "claude-3")
	for i := 0; i < 15; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: fmt.Sprintf("question-%d", i)})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: fmt.Sprintf("answer-%d", i)})
	}

	var receivedText string
	summarize := func(text string) (string, error) {
		receivedText = text
		return "mock summary", nil
	}

	CompactWithSummary(conv, summarize, 3)

	if !strings.Contains(receivedText, "[user]") {
		t.Error("expected [user] prefix in summarized text")
	}
	if !strings.Contains(receivedText, "[assistant]") {
		t.Error("expected [assistant] prefix in summarized text")
	}
}

func TestCompactWithSummary_InsertsSummaryAsFirstMessage(t *testing.T) {
	conv := CreateConversation("summary-insert", "", "claude-3")
	for i := 0; i < 15; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	summarize := func(text string) (string, error) {
		return "the summary text", nil
	}

	CompactWithSummary(conv, summarize, 3)

	first := conv.Messages[0]
	if first.Role != "user" {
		t.Errorf("first message role = %q, want user", first.Role)
	}
	blocks, ok := first.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected []LlmContentBlock")
	}
	if !strings.Contains(blocks[0].Text, "Previous conversation summary") {
		t.Error("expected summary prefix")
	}
	if !strings.Contains(blocks[0].Text, "the summary text") {
		t.Error("expected summary content")
	}
}

// --- Branch and rebuild ---

func TestGetContextUsage_ExactThreshold(t *testing.T) {
	conv := CreateConversation("threshold", "", "claude-3")
	conv.LastInputTokens = 200000

	info := GetContextUsage(conv, 200000)
	if info.Percent != 100 {
		t.Errorf("expected 100%% at exact limit, got %d", info.Percent)
	}
}

func TestMicroCompact_SkipsImageBlocks(t *testing.T) {
	conv := CreateConversation("micro-image", "", "claude-3")

	longContent := strings.Repeat("x", 200)

	// Old turn with tool_result + image blocks
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
			{Type: "image", Source: &types.ImageSource{
				Type: "base64", MediaType: "image/png", Data: strings.Repeat("A", 500),
			}},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 1 {
		t.Fatalf("expected 1 cleared (tool_result only), got %d", cleared)
	}

	blocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	// tool_result should be cleared
	if blocks[0].Content != "[cleared]" {
		t.Errorf("expected tool_result to be cleared, got %q", blocks[0].Content)
	}
	// image block should be preserved
	if blocks[1].Type != "image" {
		t.Error("image block type should be preserved")
	}
	if blocks[1].Source == nil || blocks[1].Source.Data == "" {
		t.Error("image block source data should be preserved")
	}
}

func TestAddToolResults_DeepCopy(t *testing.T) {
	conv := CreateConversation("deep-copy", "", "claude-3")

	longContent := strings.Repeat("z", 200)
	AddToolResults(conv, []ToolResultEntry{
		{ToolUseID: "tu_1", Content: longContent},
	})

	// Simulate MicroCompact clearing the Messages copy
	msgBlocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	msgBlocks[0].Content = "[cleared]"

	// Entry copy should be unaffected
	md := asMessageData(conv.Entries[0].Data)
	if md == nil {
		t.Fatal("expected MessageData in entry")
	}
	entryBlocks, ok := md.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected []LlmContentBlock in entry content")
	}
	if entryBlocks[0].Content == "[cleared]" {
		t.Error("entry should NOT be affected by Message mutation (deep copy)")
	}
	if entryBlocks[0].Content != longContent {
		t.Errorf("expected original content in entry, got %q", entryBlocks[0].Content)
	}
}

func TestAddToolResults_WithImages(t *testing.T) {
	conv := CreateConversation("tool-images", "", "claude-3")

	AddToolResults(conv, []ToolResultEntry{
		{
			ToolUseID: "tu_1",
			Content:   "[Image: test.png]",
			Images: []*types.ImageSource{
				{Type: "base64", MediaType: "image/png", Data: "iVBOR..."},
			},
		},
	})

	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(conv.Messages))
	}

	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected []LlmContentBlock")
	}
	// Should have tool_result + image blocks
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks (tool_result + image), got %d", len(blocks))
	}
	if blocks[0].Type != "tool_result" {
		t.Errorf("first block type = %q, want tool_result", blocks[0].Type)
	}
	if blocks[1].Type != "image" {
		t.Errorf("second block type = %q, want image", blocks[1].Type)
	}
	if blocks[1].Source == nil || blocks[1].Source.MediaType != "image/png" {
		t.Error("image block should carry image source data")
	}
}

// --- Effective context window + auto-compact limit ---

func TestEffectiveContextWindow(t *testing.T) {
	tests := []struct {
		name             string
		window           int
		maxOutputTokens  int
		summaryReserve   int
		want             int
	}{
		{"defaults applied", 200000, 0, 0, 200000 - DefaultMaxOutputTokens - DefaultCompactSummaryReserve},
		{"explicit reserves", 200000, 8000, 5000, 200000 - 8000 - 5000},
		{"reserves consume window returns raw", 1000, 800, 500, 1000},
		{"zero window returns zero", 0, 0, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EffectiveContextWindow(tt.window, tt.maxOutputTokens, tt.summaryReserve)
			if got != tt.want {
				t.Errorf("EffectiveContextWindow(%d,%d,%d) = %d, want %d",
					tt.window, tt.maxOutputTokens, tt.summaryReserve, got, tt.want)
			}
		})
	}
}

func TestAutoCompactTokenLimit(t *testing.T) {
	got := AutoCompactTokenLimit(200000, 0)
	want := 200000 - DefaultMaxOutputTokens - DefaultCompactSummaryReserve
	if got != want {
		t.Errorf("AutoCompactTokenLimit(200000,0) = %d, want %d", got, want)
	}

	got = AutoCompactTokenLimit(200000, 32000)
	want = 200000 - 32000 - DefaultCompactSummaryReserve
	if got != want {
		t.Errorf("AutoCompactTokenLimit(200000,32000) = %d, want %d", got, want)
	}
}

// --- Cache invalidation across compaction paths ---

func TestCompactResetsLastInputTokens(t *testing.T) {
	conv := CreateConversation("reset-compact", "", "claude-3")
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}
	conv.LastInputTokens = 165000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	Compact(conv, 3)

	if conv.LastInputTokens != 0 {
		t.Errorf("LastInputTokens = %d after Compact, want 0", conv.LastInputTokens)
	}
	if conv.LastInputTokensMsgCount != 0 {
		t.Errorf("LastInputTokensMsgCount = %d after Compact, want 0", conv.LastInputTokensMsgCount)
	}
}

func TestMicroCompactResetsLastInputTokensWhenSomethingCleared(t *testing.T) {
	conv := CreateConversation("reset-micro", "", "claude-3")
	// 12 user/assistant pairs so MicroCompact can drop tool results from
	// older messages while keeping the last 10 turns.
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{
			Role: "user",
			Content: []types.LlmContentBlock{{
				Type:    "tool_result",
				Content: strings.Repeat("x", 500),
			}},
		})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}
	conv.LastInputTokens = 165000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	cleared := MicroCompact(conv, 10)
	if cleared == 0 {
		t.Fatal("expected MicroCompact to clear something for this fixture")
	}
	if conv.LastInputTokens != 0 {
		t.Errorf("LastInputTokens = %d after MicroCompact, want 0", conv.LastInputTokens)
	}
	if conv.LastInputTokensMsgCount != 0 {
		t.Errorf("LastInputTokensMsgCount = %d after MicroCompact, want 0", conv.LastInputTokensMsgCount)
	}
}

func TestMicroCompactNoClearKeepsTokenCache(t *testing.T) {
	conv := CreateConversation("noclear-micro", "", "claude-3")
	// Single short message — nothing to clear or truncate.
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.LastInputTokens = 42
	conv.LastInputTokensMsgCount = 1

	cleared := MicroCompact(conv, 10)
	if cleared != 0 {
		t.Fatalf("expected no clears, got %d", cleared)
	}
	if conv.LastInputTokens != 42 {
		t.Errorf("LastInputTokens = %d, want 42 (no mutation should not invalidate cache)", conv.LastInputTokens)
	}
}

func TestCompactWithSummaryResetsLastInputTokens(t *testing.T) {
	conv := CreateConversation("reset-summary", "", "claude-3")
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{
			Role:    "user",
			Content: []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("user message %d", i)}},
		})
		conv.Messages = append(conv.Messages, types.LlmMessage{
			Role:    "assistant",
			Content: []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("assistant reply %d", i)}},
		})
	}
	conv.LastInputTokens = 99999
	conv.LastInputTokensMsgCount = len(conv.Messages)

	summarize := func(text string) (string, error) { return "summary of older turns", nil }
	if err := CompactWithSummary(conv, summarize, 3); err != nil {
		t.Fatalf("CompactWithSummary returned error: %v", err)
	}
	if conv.LastInputTokens != 0 {
		t.Errorf("LastInputTokens = %d after CompactWithSummary, want 0", conv.LastInputTokens)
	}
	if conv.LastInputTokensMsgCount != 0 {
		t.Errorf("LastInputTokensMsgCount = %d after CompactWithSummary, want 0", conv.LastInputTokensMsgCount)
	}
}

func TestGetContextUsageFallsBackToEstimateAfterCompactReset(t *testing.T) {
	conv := CreateConversation("fallback", "", "claude-3")
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}
	conv.LastInputTokens = 165000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	preInfo := GetContextUsage(conv, 200000)
	if preInfo.Estimated {
		t.Fatal("setup: expected reported (non-estimated) tokens before compaction")
	}

	Compact(conv, 3)

	postInfo := GetContextUsage(conv, 200000)
	if !postInfo.Estimated {
		t.Errorf("expected estimated=true after Compact reset; got reported %d tokens", postInfo.Tokens)
	}
	if postInfo.Tokens >= 165000 {
		t.Errorf("post-compact estimate should be far below the stale 165000, got %d", postInfo.Tokens)
	}
}

// --- Context usage edge cases ---

func TestGetContextUsage_EstimatedBranch_WhenLastInputTokensZero(t *testing.T) {
	conv := CreateConversation("est-zero", "", "claude-3")
	AddUserMessage(conv, "hello world this is a message")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi there, here is a response"}}, types.LlmUsage{InputTokens: 100, OutputTokens: 50})
	// Simulate scenario where LastInputTokens is zero (e.g. after compaction reset)
	conv.LastInputTokens = 0
	conv.LastInputTokensMsgCount = 0

	info := GetContextUsage(conv, 200000)
	if !info.Estimated {
		t.Error("expected estimated=true when LastInputTokens is zero")
	}
	if info.Tokens <= 0 {
		t.Errorf("expected positive estimated tokens, got %d", info.Tokens)
	}
}

func TestGetContextUsage_AddsEstimateForNewMessages(t *testing.T) {
	conv := CreateConversation("est-incr", "", "claude-3")
	for i := 0; i < 5; i++ {
		AddUserMessage(conv, fmt.Sprintf("message %d with some content", i))
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("response %d with some content", i)}}, types.LlmUsage{InputTokens: 50000, OutputTokens: 100})
	}
	// Simulate: API reported 50000 tokens at message count 8 (after 4 pairs).
	// Then 2 more messages were added (pair 5).
	conv.LastInputTokens = 50000
	conv.LastInputTokensMsgCount = 8

	info := GetContextUsage(conv, 200000)
	if info.Estimated {
		t.Error("expected estimated=false when LastInputTokens > 0")
	}
	// Should be 50000 + estimate for messages at index 8 and 9
	if info.Tokens <= 50000 {
		t.Errorf("expected tokens > 50000 (added estimates for new messages), got %d", info.Tokens)
	}
}
