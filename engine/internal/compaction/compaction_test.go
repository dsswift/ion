package compaction

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// --- helpers ---

func textMsg(role, text string) types.LlmMessage {
	return types.LlmMessage{
		Role: role,
		Content: []types.LlmContentBlock{
			{Type: "text", Text: text},
		},
	}
}

func toolResultMsg(content string, isError bool) types.LlmMessage {
	return types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "x", Content: content, IsError: &isError},
		},
	}
}

func clearStrategiesForTest(t *testing.T) {
	t.Helper()
	ClearStrategies()
	t.Cleanup(func() { ClearStrategies() })
}

// ─── Strategy Registry ───

func TestRegistryRegisterAndGet(t *testing.T) {
	clearStrategiesForTest(t)

	s := MicroCompactStrategy{}
	RegisterStrategy(s)

	got := GetStrategy("micro-compact")
	if got == nil {
		t.Fatal("expected strategy to be registered")
	}
	if got.Name() != "micro-compact" {
		t.Errorf("got name %q, want micro-compact", got.Name())
	}
}

func TestRegistryGetUnknown(t *testing.T) {
	clearStrategiesForTest(t)

	got := GetStrategy("nonexistent")
	if got != nil {
		t.Error("expected nil for unregistered strategy")
	}
}

func TestRegistryAll(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterStrategy(MicroCompactStrategy{})
	RegisterStrategy(TruncateStrategy{})

	all := AllStrategies()
	if len(all) != 2 {
		t.Errorf("expected 2 strategies, got %d", len(all))
	}
}

func TestRegistryListNames(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterStrategy(MicroCompactStrategy{})
	RegisterStrategy(SummaryCompactStrategy{})

	names := ListStrategyNames()
	if len(names) != 2 {
		t.Fatalf("expected 2 names, got %d", len(names))
	}

	nameSet := make(map[string]bool)
	for _, n := range names {
		nameSet[n] = true
	}
	if !nameSet["micro-compact"] || !nameSet["summary-compact"] {
		t.Errorf("unexpected names: %v", names)
	}
}

func TestRegistryClear(t *testing.T) {
	ClearStrategies()
	defer ClearStrategies()

	RegisterStrategy(MicroCompactStrategy{})
	if len(AllStrategies()) == 0 {
		t.Fatal("expected at least one strategy before clear")
	}

	ClearStrategies()
	if len(AllStrategies()) != 0 {
		t.Error("expected 0 strategies after clear")
	}
}

func TestRegistryPreferredOrder(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterStrategy(MicroCompactStrategy{})
	RegisterStrategy(TruncateStrategy{})

	SetPreferredOrder([]string{"truncate", "micro-compact"})

	order := GetPreferredOrder()
	if len(order) != 2 {
		t.Fatalf("expected 2, got %d", len(order))
	}
	if order[0] != "truncate" || order[1] != "micro-compact" {
		t.Errorf("unexpected order: %v", order)
	}
}

func TestGetPreferredOrderFallback(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterStrategy(MicroCompactStrategy{})
	RegisterStrategy(TruncateStrategy{})
	// No SetPreferredOrder -- should fall back to all registered names.

	order := GetPreferredOrder()
	if len(order) != 2 {
		t.Errorf("expected 2 names in fallback order, got %d", len(order))
	}
}

// ─── SelectStrategy ───

func TestSelectStrategyPreferredOrder(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterStrategy(MicroCompactStrategy{})
	RegisterStrategy(TruncateStrategy{})
	// Truncate canHandle requires >2 messages, micro-compact requires >0.
	// With 1 message only micro-compact matches.
	SetPreferredOrder([]string{"truncate", "micro-compact"})

	msgs := []types.LlmMessage{textMsg("user", "hi")}
	s := SelectStrategy(msgs, nil)
	if s == nil {
		t.Fatal("expected a strategy")
	}
	if s.Name() != "micro-compact" {
		t.Errorf("expected micro-compact (truncate needs >2), got %q", s.Name())
	}
}

func TestSelectStrategyFallback(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterStrategy(MicroCompactStrategy{})
	// No preferred order set; should still find micro-compact.
	msgs := []types.LlmMessage{textMsg("user", "hi")}
	s := SelectStrategy(msgs, nil)
	if s == nil {
		t.Fatal("expected fallback strategy")
	}
	if s.Name() != "micro-compact" {
		t.Errorf("got %q", s.Name())
	}
}

func TestSelectStrategyNoMatch(t *testing.T) {
	clearStrategiesForTest(t)

	// Register truncate only (needs >2 messages) and pass 1 message.
	RegisterStrategy(TruncateStrategy{})
	msgs := []types.LlmMessage{textMsg("user", "hi")}
	s := SelectStrategy(msgs, nil)
	if s != nil {
		t.Errorf("expected nil, got %q", s.Name())
	}
}

// ─── ExecuteCompaction ───

func TestExecuteCompactionByName(t *testing.T) {
	clearStrategiesForTest(t)
	RegisterStrategy(TruncateStrategy{})

	msgs := []types.LlmMessage{
		textMsg("user", "m1"),
		textMsg("assistant", "m2"),
		textMsg("user", "m3"),
		textMsg("assistant", "m4"),
	}
	out, result, err := ExecuteCompaction(msgs, &CompactionOptions{KeepTurns: 2}, "truncate")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 2 {
		t.Errorf("expected 2 messages, got %d", len(out))
	}
	if result.Strategy != "truncate" {
		t.Errorf("expected strategy=truncate, got %q", result.Strategy)
	}
}

func TestExecuteCompactionAutoSelect(t *testing.T) {
	clearStrategiesForTest(t)
	RegisterStrategy(MicroCompactStrategy{})

	msgs := []types.LlmMessage{textMsg("user", "hi")}
	out, result, err := ExecuteCompaction(msgs, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Strategy != "micro-compact" {
		t.Errorf("expected micro-compact, got %q", result.Strategy)
	}
	if len(out) != 1 {
		t.Errorf("expected 1 message, got %d", len(out))
	}
}

func TestExecuteCompactionUnknownName(t *testing.T) {
	clearStrategiesForTest(t)

	_, _, err := ExecuteCompaction(nil, nil, "nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown strategy name")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got: %v", err)
	}
}

func TestExecuteCompactionNoStrategy(t *testing.T) {
	clearStrategiesForTest(t)

	_, _, err := ExecuteCompaction(nil, nil, "")
	if err == nil {
		t.Fatal("expected error when no strategy can handle")
	}
	if !strings.Contains(err.Error(), "no compaction strategy") {
		t.Errorf("unexpected error: %v", err)
	}
}

// ─── MicroCompactStrategy ───

func TestMicroCompactCanHandle(t *testing.T) {
	s := MicroCompactStrategy{}
	if !s.CanHandle([]types.LlmMessage{textMsg("user", "hi")}, nil) {
		t.Error("expected CanHandle=true for non-empty messages")
	}
	if s.CanHandle(nil, nil) {
		t.Error("expected CanHandle=false for nil messages")
	}
	if s.CanHandle([]types.LlmMessage{}, nil) {
		t.Error("expected CanHandle=false for empty messages")
	}
}

func TestMicroCompactClearsToolResults(t *testing.T) {
	isErr := false
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "t1", Content: "long tool result content here", IsError: &isErr},
		}},
		textMsg("assistant", "I see the result"),
	}

	s := MicroCompactStrategy{}
	out, result, err := s.Compact(msgs, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Strategy != "micro-compact" {
		t.Errorf("expected strategy=micro-compact, got %q", result.Strategy)
	}
	if result.MessagesBefore != 2 || result.MessagesAfter != 2 {
		t.Errorf("expected 2->2 messages, got %d->%d", result.MessagesBefore, result.MessagesAfter)
	}

	// First message's tool_result content should be "[compacted]"
	blocks, ok := out[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content blocks")
	}
	if blocks[0].Content != "[compacted]" {
		t.Errorf("expected [compacted], got %q", blocks[0].Content)
	}
}

func TestMicroCompactPreservesRecentText(t *testing.T) {
	msgs := []types.LlmMessage{
		textMsg("user", "hello"),
		textMsg("assistant", "world"),
	}

	s := MicroCompactStrategy{}
	out, _, err := s.Compact(msgs, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Text messages should pass through unchanged.
	blocks0, ok := out[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content blocks")
	}
	if blocks0[0].Text != "hello" {
		t.Errorf("expected 'hello', got %q", blocks0[0].Text)
	}
	blocks1, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content blocks")
	}
	if blocks1[0].Text != "world" {
		t.Errorf("expected 'world', got %q", blocks1[0].Text)
	}
}

// ─── SummaryCompactStrategy ───

func TestSummaryCompactCanHandle(t *testing.T) {
	s := SummaryCompactStrategy{}

	// Needs >2 messages AND a summarizer.
	msgs3 := []types.LlmMessage{
		textMsg("user", "a"),
		textMsg("assistant", "b"),
		textMsg("user", "c"),
	}
	if !s.CanHandle(msgs3, &CompactionOptions{Summarize: func(string) (string, error) { return "", nil }}) {
		t.Error("expected CanHandle=true with 3 msgs and summarizer")
	}
	if s.CanHandle(msgs3, nil) {
		t.Error("expected CanHandle=false with nil opts")
	}
	if s.CanHandle(msgs3, &CompactionOptions{}) {
		t.Error("expected CanHandle=false without summarizer")
	}
	if s.CanHandle([]types.LlmMessage{textMsg("user", "a")}, &CompactionOptions{Summarize: func(string) (string, error) { return "", nil }}) {
		t.Error("expected CanHandle=false with <=2 messages")
	}
}

func TestSummaryCompactCallsSummarizer(t *testing.T) {
	s := SummaryCompactStrategy{}

	msgs := []types.LlmMessage{
		textMsg("user", "first question"),
		textMsg("assistant", "first answer"),
		textMsg("user", "second question"),
		textMsg("assistant", "second answer"),
		textMsg("user", "third question"),
	}

	var receivedText string
	opts := &CompactionOptions{
		KeepTurns: 2,
		Summarize: func(text string) (string, error) {
			receivedText = text
			return "mock summary", nil
		},
	}

	out, result, err := s.Compact(msgs, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Strategy != "summary-compact" {
		t.Errorf("expected summary-compact, got %q", result.Strategy)
	}
	if result.MessagesBefore != 5 {
		t.Errorf("expected 5 before, got %d", result.MessagesBefore)
	}
	// Summary (1) + kept turns (2) = 3
	if result.MessagesAfter != 3 {
		t.Errorf("expected 3 after, got %d", result.MessagesAfter)
	}

	// Summarizer should have received text from older messages.
	if !strings.Contains(receivedText, "[user]") || !strings.Contains(receivedText, "[assistant]") {
		t.Errorf("expected role labels in summarizer input, got: %s", receivedText)
	}

	// First message should be the summary.
	blocks, ok := out[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content blocks on summary message")
	}
	if !strings.Contains(blocks[0].Text, "[Conversation summary]") {
		t.Errorf("expected summary prefix, got: %s", blocks[0].Text)
	}
	if !strings.Contains(blocks[0].Text, "mock summary") {
		t.Errorf("expected mock summary content, got: %s", blocks[0].Text)
	}
}

func TestSummaryCompactHandlesError(t *testing.T) {
	s := SummaryCompactStrategy{}

	msgs := []types.LlmMessage{
		textMsg("user", "a"),
		textMsg("assistant", "b"),
		textMsg("user", "c"),
	}

	opts := &CompactionOptions{
		KeepTurns: 1,
		Summarize: func(string) (string, error) {
			return "", fmt.Errorf("LLM failed")
		},
	}

	_, _, err := s.Compact(msgs, opts)
	if err == nil {
		t.Fatal("expected error from summarizer failure")
	}
	if !strings.Contains(err.Error(), "LLM failed") {
		t.Errorf("expected LLM failed in error, got: %v", err)
	}
}

func TestSummaryCompactNilSummarizer(t *testing.T) {
	s := SummaryCompactStrategy{}
	msgs := []types.LlmMessage{
		textMsg("user", "a"),
		textMsg("assistant", "b"),
		textMsg("user", "c"),
	}
	_, _, err := s.Compact(msgs, &CompactionOptions{})
	if err == nil {
		t.Fatal("expected error when Summarize is nil")
	}
}

// ─── TruncateStrategy ───

func TestTruncateCanHandle(t *testing.T) {
	s := TruncateStrategy{}
	if s.CanHandle([]types.LlmMessage{textMsg("user", "a")}, nil) {
		t.Error("expected CanHandle=false for 1 message")
	}
	if s.CanHandle([]types.LlmMessage{textMsg("user", "a"), textMsg("assistant", "b")}, nil) {
		t.Error("expected CanHandle=false for 2 messages")
	}
	if !s.CanHandle([]types.LlmMessage{textMsg("user", "a"), textMsg("assistant", "b"), textMsg("user", "c")}, nil) {
		t.Error("expected CanHandle=true for 3 messages")
	}
}

func TestTruncateKeepsNTurns(t *testing.T) {
	s := TruncateStrategy{}

	msgs := make([]types.LlmMessage, 10)
	for i := range msgs {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		msgs[i] = textMsg(role, fmt.Sprintf("msg-%d", i))
	}

	out, result, err := s.Compact(msgs, &CompactionOptions{KeepTurns: 4})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 4 {
		t.Errorf("expected 4 messages, got %d", len(out))
	}
	if result.Strategy != "truncate" {
		t.Errorf("expected strategy=truncate, got %q", result.Strategy)
	}
	if result.MessagesBefore != 10 {
		t.Errorf("expected 10 before, got %d", result.MessagesBefore)
	}
	if result.MessagesAfter != 4 {
		t.Errorf("expected 4 after, got %d", result.MessagesAfter)
	}

	// Should keep the last 4.
	blocks, _ := out[0].Content.([]types.LlmContentBlock)
	if blocks[0].Text != "msg-6" {
		t.Errorf("expected msg-6, got %q", blocks[0].Text)
	}
}

func TestTruncateFewerThanKeepTurns(t *testing.T) {
	s := TruncateStrategy{}

	msgs := []types.LlmMessage{
		textMsg("user", "a"),
		textMsg("assistant", "b"),
		textMsg("user", "c"),
	}

	out, result, err := s.Compact(msgs, &CompactionOptions{KeepTurns: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// When keepTurns >= len(messages), all are kept.
	if len(out) != 3 {
		t.Errorf("expected 3, got %d", len(out))
	}
	if result.MessagesAfter != 3 {
		t.Errorf("expected 3 after, got %d", result.MessagesAfter)
	}
}

func TestTruncateDefaultKeepTurns(t *testing.T) {
	s := TruncateStrategy{}

	msgs := make([]types.LlmMessage, 6)
	for i := range msgs {
		msgs[i] = textMsg("user", fmt.Sprintf("m%d", i))
	}

	out, _, err := s.Compact(msgs, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Default keepTurns=2.
	if len(out) != 2 {
		t.Errorf("expected 2 (default keepTurns), got %d", len(out))
	}
}

// ─── RegisterBuiltinStrategies ───

func TestRegisterBuiltinStrategies(t *testing.T) {
	clearStrategiesForTest(t)

	RegisterBuiltinStrategies()

	names := ListStrategyNames()
	nameSet := make(map[string]bool)
	for _, n := range names {
		nameSet[n] = true
	}

	for _, want := range []string{"micro-compact", "summary-compact", "truncate"} {
		if !nameSet[want] {
			t.Errorf("expected %q to be registered", want)
		}
	}
}

// ─── Fact Extraction (5 patterns) ───

func TestExtractFacts(t *testing.T) {
	messages := []types.LlmMessage{
		{Role: "assistant", Content: "I decided to use Go for this project."},
		{Role: "assistant", Content: "Found that the config file was missing."},
		{Role: "assistant", Content: "The build failed with an error."},
		{Role: "assistant", Content: "You should always use strict mode."},
	}

	facts := ExtractFacts(messages)
	if len(facts) == 0 {
		t.Fatal("expected facts to be extracted")
	}

	typeSet := make(map[string]bool)
	for _, f := range facts {
		typeSet[f.Type] = true
	}

	expected := []string{"decision", "discovery", "error", "preference"}
	for _, e := range expected {
		if !typeSet[e] {
			t.Errorf("expected fact type %q to be extracted", e)
		}
	}
}

func TestExtractFactsDecision(t *testing.T) {
	msgs := []types.LlmMessage{textMsg("assistant", "I decided to use TypeScript for this module")}
	facts := ExtractFacts(msgs)
	found := false
	for _, f := range facts {
		if f.Type == "decision" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected decision fact")
	}
}

func TestExtractFactsFileMod(t *testing.T) {
	isErr := false
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "x", Content: "Wrote to /src/foo.ts", IsError: &isErr},
		}},
	}
	facts := ExtractFacts(msgs)
	found := false
	for _, f := range facts {
		if f.Type == "file_mod" && strings.Contains(f.Content, "/src/foo.ts") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected file_mod fact with /src/foo.ts")
	}
}

func TestExtractFactsError(t *testing.T) {
	msgs := []types.LlmMessage{textMsg("assistant", "The build failed with a critical error")}
	facts := ExtractFacts(msgs)
	found := false
	for _, f := range facts {
		if f.Type == "error" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected error fact")
	}
}

func TestExtractFactsPreference(t *testing.T) {
	msgs := []types.LlmMessage{textMsg("user", "I prefer functional style over classes")}
	facts := ExtractFacts(msgs)
	found := false
	for _, f := range facts {
		if f.Type == "preference" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected preference fact")
	}
}

func TestExtractFactsDiscovery(t *testing.T) {
	msgs := []types.LlmMessage{textMsg("assistant", "Found the issue is a race condition")}
	facts := ExtractFacts(msgs)
	found := false
	for _, f := range facts {
		if f.Type == "discovery" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected discovery fact")
	}
}

func TestExtractFactsEmpty(t *testing.T) {
	facts := ExtractFacts(nil)
	if len(facts) != 0 {
		t.Errorf("expected 0 facts from nil, got %d", len(facts))
	}
}

func TestExtractFactsNoPatterns(t *testing.T) {
	msgs := []types.LlmMessage{textMsg("user", "hello"), textMsg("assistant", "hi there")}
	facts := ExtractFacts(msgs)
	if len(facts) != 0 {
		t.Errorf("expected 0 facts for plain messages, got %d", len(facts))
	}
}

// ─── Fact Formatting ───

func TestFormatFactsSummary(t *testing.T) {
	facts := []Fact{
		{Type: "decision", Content: "Use Go"},
		{Type: "error", Content: "Build failed"},
		{Type: "decision", Content: "Use modules"},
	}

	summary := FormatFactsSummary(facts)
	if !strings.Contains(summary, "## Decisions") {
		t.Error("expected Decisions header")
	}
	if !strings.Contains(summary, "## Errors Encountered") {
		t.Error("expected Errors header")
	}
	if !strings.Contains(summary, "- Use Go") {
		t.Error("expected 'Use Go' in summary")
	}
}

func TestFormatFactsSummaryGroupedByType(t *testing.T) {
	facts := []Fact{
		{Type: "decision", Content: "Use React"},
		{Type: "file_mod", Content: "/src/app.ts"},
		{Type: "preference", Content: "Always use strict mode"},
		{Type: "discovery", Content: "The config was wrong"},
	}

	summary := FormatFactsSummary(facts)
	if !strings.Contains(summary, "## Decisions") {
		t.Error("missing Decisions header")
	}
	if !strings.Contains(summary, "## Files Modified") {
		t.Error("missing Files Modified header")
	}
	if !strings.Contains(summary, "## Preferences") {
		t.Error("missing Preferences header")
	}
	if !strings.Contains(summary, "## Discoveries") {
		t.Error("missing Discoveries header")
	}
}

func TestFormatFactsSummaryOmitsEmpty(t *testing.T) {
	facts := []Fact{
		{Type: "decision", Content: "Use React"},
	}
	summary := FormatFactsSummary(facts)
	if !strings.Contains(summary, "## Decisions") {
		t.Error("expected Decisions header")
	}
	if strings.Contains(summary, "Errors") {
		t.Error("should not contain Errors header for empty section")
	}
	if strings.Contains(summary, "Files Modified") {
		t.Error("should not contain Files Modified header for empty section")
	}
}

func TestFormatFactsSummaryMarkdownHeaders(t *testing.T) {
	facts := []Fact{
		{Type: "decision", Content: "A"},
		{Type: "error", Content: "B"},
	}
	summary := FormatFactsSummary(facts)
	// Each section should use markdown ## headers.
	lines := strings.Split(summary, "\n")
	headerCount := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			headerCount++
		}
	}
	if headerCount != 2 {
		t.Errorf("expected 2 markdown headers, got %d", headerCount)
	}
}

// ─── Partial Compaction ───

func buildTestConv(turns int) *conversation.Conversation {
	conv := conversation.CreateConversation("test", "system", "model")
	for i := 0; i < turns; i++ {
		conversation.AddUserMessage(conv, fmt.Sprintf("User message %d", i))
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{
			{Type: "text", Text: fmt.Sprintf("Assistant message %d", i)},
		}, types.LlmUsage{InputTokens: 100, OutputTokens: 50})
	}
	return conv
}

func TestCompactPartialBefore(t *testing.T) {
	conv := buildTestConv(5) // 10 entries
	originalLen := len(conv.Entries)
	if originalLen != 10 {
		t.Fatalf("expected 10 entries, got %d", originalLen)
	}

	pivotID := conv.Entries[4].ID // midpoint

	err := CompactPartial(conv, pivotID, "before")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should keep entries from pivot onward.
	if len(conv.Entries) >= originalLen {
		t.Errorf("expected fewer entries after compact before, got %d", len(conv.Entries))
	}
	if conv.Entries[0].ID != pivotID {
		t.Errorf("first entry should be pivot, got %q", conv.Entries[0].ID)
	}
}

func TestCompactPartialAfter(t *testing.T) {
	conv := buildTestConv(5)
	pivotID := conv.Entries[4].ID

	err := CompactPartial(conv, pivotID, "after")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Should keep entries up to and including pivot.
	if len(conv.Entries) != 5 {
		t.Errorf("expected 5 entries after compact after, got %d", len(conv.Entries))
	}
	lastEntry := conv.Entries[len(conv.Entries)-1]
	if lastEntry.ID != pivotID {
		t.Errorf("last entry should be pivot, got %q", lastEntry.ID)
	}
	// LeafID should be updated to last entry.
	if conv.LeafID == nil || *conv.LeafID != pivotID {
		t.Error("LeafID should point to pivot after compact-after")
	}
}

func TestCompactPartialPivotNotFound(t *testing.T) {
	conv := buildTestConv(3)

	err := CompactPartial(conv, "nonexistent-entry-id", "before")
	if err == nil {
		t.Fatal("expected error for missing pivot")
	}
	if !strings.Contains(err.Error(), "pivot entry not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestCompactPartialEmptyConversation(t *testing.T) {
	conv := conversation.CreateConversation("empty", "system", "model")
	err := CompactPartial(conv, "any", "before")
	if err != nil {
		t.Errorf("expected no error for empty conversation, got: %v", err)
	}
}

func TestCompactPartialInvalidDirection(t *testing.T) {
	conv := buildTestConv(2)
	pivotID := conv.Entries[1].ID

	err := CompactPartial(conv, pivotID, "sideways")
	if err == nil {
		t.Fatal("expected error for invalid direction")
	}
	if !strings.Contains(err.Error(), "invalid direction") {
		t.Errorf("unexpected error: %v", err)
	}
}

// ─── PostCompactRestore ───

func TestPostCompactRestore(t *testing.T) {
	msg := PostCompactRestore(nil, []string{"/a.go", "/b.go"}, []string{"bash"})
	text := ""
	if blocks, ok := msg.Content.([]types.LlmContentBlock); ok && len(blocks) > 0 {
		text = blocks[0].Text
	}
	if !strings.Contains(text, "/a.go") {
		t.Error("expected file paths in restore message")
	}
	if !strings.Contains(text, "bash") {
		t.Error("expected deferred tools in restore message")
	}
}

func TestPostCompactRestoreCreatesSystemMessage(t *testing.T) {
	msg := PostCompactRestore(nil, []string{"/x.go"}, nil)
	if msg.Role != "user" {
		t.Errorf("expected role=user, got %q", msg.Role)
	}
	blocks, ok := msg.Content.([]types.LlmContentBlock)
	if !ok || len(blocks) == 0 {
		t.Fatal("expected content blocks")
	}
	if !strings.Contains(blocks[0].Text, "[Post-compaction context restore]") {
		t.Errorf("expected context restore header, got: %s", blocks[0].Text)
	}
}

func TestPostCompactRestoreEmpty(t *testing.T) {
	msg := PostCompactRestore(nil, nil, nil)
	blocks, ok := msg.Content.([]types.LlmContentBlock)
	if !ok || len(blocks) == 0 {
		t.Fatal("expected content blocks")
	}
	// With no files and no tools, should just have the header.
	if blocks[0].Text != "[Post-compaction context restore]" {
		t.Errorf("expected just the header, got: %s", blocks[0].Text)
	}
}

// ─── ExtractRecentFiles ───

func TestExtractRecentFiles(t *testing.T) {
	isErr := false
	messages := []types.LlmMessage{
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "t1", Content: "Modified /src/main.go and ./config.yaml", IsError: &isErr},
			},
		},
	}

	files := ExtractRecentFiles(messages)
	if len(files) == 0 {
		t.Fatal("expected files to be extracted")
	}

	found := make(map[string]bool)
	for _, f := range files {
		found[f] = true
	}
	if !found["/src/main.go"] {
		t.Error("expected /src/main.go")
	}
}

func TestExtractRecentFilesDeduplication(t *testing.T) {
	isErr := false
	messages := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "t1", Content: "Read /a.ts", IsError: &isErr},
		}},
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "t2", Content: "Edited /a.ts", IsError: &isErr},
		}},
	}

	files := ExtractRecentFiles(messages)
	count := 0
	for _, f := range files {
		if f == "/a.ts" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected /a.ts to appear once (dedup), got %d", count)
	}
}

func TestExtractRecentFilesNoPaths(t *testing.T) {
	isErr := false
	messages := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "t1", Content: "no file paths here", IsError: &isErr},
		}},
	}

	files := ExtractRecentFiles(messages)
	if len(files) != 0 {
		t.Errorf("expected 0 files, got %d", len(files))
	}
}

// ─── Edge Cases ───

func TestEmptyMessages(t *testing.T) {
	s := MicroCompactStrategy{}
	out, result, err := s.Compact([]types.LlmMessage{}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("expected 0, got %d", len(out))
	}
	if result.MessagesBefore != 0 || result.MessagesAfter != 0 {
		t.Errorf("expected 0->0, got %d->%d", result.MessagesBefore, result.MessagesAfter)
	}
}

func TestSingleMessage(t *testing.T) {
	s := MicroCompactStrategy{}
	msgs := []types.LlmMessage{textMsg("user", "hello")}
	out, _, err := s.Compact(msgs, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 1 {
		t.Errorf("expected 1, got %d", len(out))
	}
}

func TestMessageWithStringContent(t *testing.T) {
	// Messages with plain string content (not blocks) should pass through.
	s := MicroCompactStrategy{}
	msgs := []types.LlmMessage{
		{Role: "user", Content: "plain string content"},
	}
	out, _, err := s.Compact(msgs, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 1 {
		t.Errorf("expected 1, got %d", len(out))
	}
	// String content should pass through unchanged.
	if out[0].Content != "plain string content" {
		t.Errorf("expected unchanged string content")
	}
}

func TestExtractFactsSourceIndex(t *testing.T) {
	msgs := []types.LlmMessage{
		textMsg("user", "hello"),
		textMsg("assistant", "I decided to use Go"),
	}
	facts := ExtractFacts(msgs)
	for _, f := range facts {
		if f.Type == "decision" && f.Source != 1 {
			t.Errorf("expected source index 1, got %d", f.Source)
		}
	}
}
