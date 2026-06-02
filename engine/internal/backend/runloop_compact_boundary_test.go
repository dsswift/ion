package backend

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// testCP returns a compactParams suitable for boundary tests. The token
// budget is generous so truncation still fires on the small fixtures
// but doesn't interfere with boundary assertions.
func testCP() compactParams {
	return compactParams{
		targetPercent:     50,
		microKeepTurns:    3,
		minKeepTurns:      2,
		estimationPadding: 1.0,
	}
}

// Small enough that CompactToTokenBudget actually drops messages on
// these tiny fixtures, which is required for the duplication firewall
// test to work (old keyword messages must be truncated away).
const testContextWindow = 100

// TestCompactReactive_InjectsCompactBoundary verifies the runloop swaps
// the old triple-message scheme (system-cleared note + extracted-facts
// message + post-compact-restore message) for a single typed
// compact_boundary block.
//
// The old behaviour described in the gentle-knitting-cup plan as cause
// #1: three overlapping bookkeeping messages per compaction. The
// post-fix expectation: exactly one compact_boundary block at index 0.
func TestCompactReactive_InjectsCompactBoundary(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "reactive-boundary")

	conv := conversation.CreateConversation("reactive-boundary", "", "test-model")
	// Seed with content that produces facts so the boundary's Summary
	// field is non-empty (the regex path renders FormatFactsSummary).
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use SQLite for storage."},
		types.LlmMessage{Role: "assistant", Content: "Acknowledged; build failed in passing."},
	)
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}

	run := &activeRun{requestID: "reactive-boundary", conv: conv}
	if !b.compactReactive(context.Background(), run, conv, RunHooks{}, testContextWindow, 1, testCP()) {
		t.Fatalf("compactReactive returned false; expected true")
	}

	// Exactly one boundary at the head of the surviving slice.
	if !conversation.IsCompactBoundary(conv.Messages[0]) {
		t.Fatalf("first message after compaction is not a compact_boundary: %+v", conv.Messages[0])
	}

	// No other boundary blocks anywhere (we should never inject two per
	// compaction).
	boundaryCount := 0
	for _, m := range conv.Messages {
		if conversation.IsCompactBoundary(m) {
			boundaryCount++
		}
	}
	if boundaryCount != 1 {
		t.Errorf("expected exactly 1 boundary block, got %d", boundaryCount)
	}

	// Inspect the boundary's structured fields.
	blocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[0].Trigger != "reactive" {
		t.Errorf("boundary.Trigger = %q, want reactive", blocks[0].Trigger)
	}
	if blocks[0].MessagesBefore == 0 {
		t.Error("boundary.MessagesBefore should be populated")
	}
	// The old "[SYSTEM] Context compaction cleared N older tool
	// results" transient must NOT appear anywhere as a separate
	// message. The cleared-block count now lives on the boundary's
	// ClearedBlocks field. ClearedBlocks may legitimately be zero on
	// this fixture (no tool_result blocks to clear), so we only check
	// the absence of the prose, not the numeric field.
	for _, m := range conv.Messages {
		if conversation.IsCompactBoundary(m) {
			continue
		}
		if s, ok := m.Content.(string); ok && strings.Contains(s, "[SYSTEM] Context compaction cleared") {
			t.Errorf("legacy [SYSTEM] Context compaction cleared transient still present: %q", s)
		}
		if blocks, ok := m.Content.([]types.LlmContentBlock); ok {
			for _, b := range blocks {
				if strings.Contains(b.Text, "[SYSTEM] Context compaction cleared") {
					t.Errorf("legacy [SYSTEM] Context compaction cleared transient still present in block: %q", b.Text)
				}
				if strings.Contains(b.Text, "[Post-compaction context restore]") {
					t.Errorf("legacy [Post-compaction context restore] block still present: %q", b.Text)
				}
				if strings.Contains(b.Text, "[Extracted facts from compacted context]") {
					t.Errorf("legacy [Extracted facts from compacted context] block still present: %q", b.Text)
				}
			}
		}
	}
}

// TestCompactReactive_HookPathShortCircuitsRegex pins the new
// OnRequestCompactSummary hook contract: when the harness supplies a
// non-empty summary the engine uses it verbatim and does not run its
// regex fallback.
func TestCompactReactive_HookPathShortCircuitsRegex(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "reactive-hook")

	conv := conversation.CreateConversation("reactive-hook", "", "test-model")
	// Seed content the regex extractor would pick up so we can verify
	// the regex output is NOT what landed in Summary.
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use Go."},
	)
	for i := 0; i < 22; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}

	hookCalls := 0
	gotStrategy := ""
	const hookSummary = "harness-generated summary"
	hooks := RunHooks{
		OnRequestCompactSummary: func(_ string, strategy string, _ []types.LlmMessage) (string, bool) {
			hookCalls++
			gotStrategy = strategy
			return hookSummary, true
		},
	}

	run := &activeRun{requestID: "reactive-hook", conv: conv}
	if !b.compactReactive(context.Background(), run, conv, hooks, testContextWindow, 1, testCP()) {
		t.Fatalf("compactReactive returned false")
	}

	if gotStrategy != "reactive" {
		t.Errorf("hook received strategy=%q, want %q (compactReactive must always pass \"reactive\")", gotStrategy, "reactive")
	}

	if hookCalls != 1 {
		t.Errorf("expected OnRequestCompactSummary to be called exactly once, got %d", hookCalls)
	}

	blocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !conversation.IsCompactBoundary(conv.Messages[0]) {
		t.Fatal("first message should be a compact_boundary")
	}
	if blocks[0].Summary != hookSummary {
		t.Errorf("boundary.Summary = %q, want harness-supplied %q", blocks[0].Summary, hookSummary)
	}
	// The regex path (FormatFactsSummary) would emit a "## Decisions"
	// markdown header for the seeded "decided to use Go" content. Its
	// absence proves the hook short-circuited the regex path.
	if strings.Contains(blocks[0].Summary, "## Decisions") {
		t.Error("boundary.Summary contains regex output; hook should have short-circuited")
	}
}

// TestCompactReactive_HookEmptyReturnFallsBackToRegex is the negative
// half of the hook contract: when the hook is wired but returns
// ("", false) (or just an empty string), the engine falls back to the
// regex pipeline. Harnesses use this when a model call fails or the
// session shouldn't be summarised.
func TestCompactReactive_HookEmptyReturnFallsBackToRegex(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "reactive-hook-empty")

	conv := conversation.CreateConversation("reactive-hook-empty", "", "test-model")
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use Go."},
	)
	for i := 0; i < 22; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}

	hookCalls := 0
	gotStrategy := ""
	hooks := RunHooks{
		OnRequestCompactSummary: func(_ string, strategy string, _ []types.LlmMessage) (string, bool) {
			hookCalls++
			gotStrategy = strategy
			return "", false
		},
	}

	run := &activeRun{requestID: "reactive-hook-empty", conv: conv}
	if !b.compactReactive(context.Background(), run, conv, hooks, testContextWindow, 1, testCP()) {
		t.Fatalf("compactReactive returned false")
	}

	if gotStrategy != "reactive" {
		t.Errorf("hook received strategy=%q, want %q", gotStrategy, "reactive")
	}

	if hookCalls != 1 {
		t.Errorf("expected hook to be called once even when it returns empty, got %d", hookCalls)
	}

	blocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	// Regex fallback should have produced a Decisions section.
	if !strings.Contains(blocks[0].Summary, "## Decisions") {
		t.Errorf("expected regex fallback to render Decisions section, got Summary=%q", blocks[0].Summary)
	}
}

// TestCompactReactive_DuplicationFirewall is the headline regression
// guard: running compaction twice must not let the second pass's
// boundary contain facts re-extracted from the first pass's summary.
//
// Without MessagesAfterLastCompactBoundary the regex extractor would
// walk the first boundary's Summary text (which carries words like
// "decided", "failed", and file paths), emit them as facts again, and
// the second summary would visibly compound the first. The structural
// boundary block + the slice helper close that loop.
func TestCompactReactive_DuplicationFirewall(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "firewall")

	conv := conversation.CreateConversation("firewall", "", "test-model")
	// Seed unique fact text so the first pass's Summary contains
	// keywords that would re-trigger the regex extractor if it ever
	// walked the boundary.
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use UNIQUEKEYWORD-ALPHA for storage."},
	)
	for i := 0; i < 22; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}

	run := &activeRun{requestID: "firewall", conv: conv}

	// Pass 1
	if !b.compactReactive(context.Background(), run, conv, RunHooks{}, testContextWindow, 1, testCP()) {
		t.Fatalf("first compactReactive returned false")
	}
	firstBlocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	firstSummary := firstBlocks[0].Summary
	if !strings.Contains(firstSummary, "UNIQUEKEYWORD-ALPHA") {
		t.Fatalf("setup failed: first summary did not capture seeded keyword: %q", firstSummary)
	}

	// Append enough filler to force a second compaction without
	// introducing any new fact-keyword text.
	for i := 0; i < 22; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "second pass filler"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "more filler"})
	}

	// Pass 2
	if !b.compactReactive(context.Background(), run, conv, RunHooks{}, testContextWindow, 2, testCP()) {
		t.Fatalf("second compactReactive returned false")
	}

	// The latest boundary (head of the slice) must NOT contain the
	// unique keyword — that would mean the regex extractor re-mined the
	// first boundary's Summary text and the firewall has a hole.
	latestBlocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	if strings.Contains(latestBlocks[0].Summary, "UNIQUEKEYWORD-ALPHA") {
		t.Errorf("duplication firewall leak: second boundary's Summary contains a fact from the first boundary: %q", latestBlocks[0].Summary)
	}
}

// TestCompactIfNeeded_InjectsCompactBoundary is the proactive-path
// counterpart to TestCompactReactive_InjectsCompactBoundary. The two
// runloop sites (compactIfNeeded and compactReactive) inject the same
// typed boundary via the shared injectCompactBoundary helper, but the
// proactive path was uncovered until this test landed — a regression
// that broke proactive injection while leaving reactive untouched would
// ship green.
//
// Setup mirrors the reactive test: a seeded conversation with content
// the regex extractor will pick up, plus enough filler that
// CompactToTokenBudget actually drops messages. The two key knobs that
// differ are LastInputTokens (so usage.Tokens > tokenLimit triggers the
// proactive entry) and the explicit (contextWindow, tokenLimit) args
// passed to compactIfNeeded (the reactive path infers these from
// usageBefore on each retry).
func TestCompactIfNeeded_InjectsCompactBoundary(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "proactive-boundary")

	conv := conversation.CreateConversation("proactive-boundary", "", "test-model")
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use SQLite for storage."},
		types.LlmMessage{Role: "assistant", Content: "Acknowledged; build failed in passing."},
	)
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}
	// Prime LastInputTokens above tokenLimit so usage.Tokens > tokenLimit
	// at the top of compactIfNeeded; without this priming the function
	// short-circuits before reaching the boundary-injection branch.
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	run := &activeRun{requestID: "proactive-boundary", conv: conv}
	cp := testCP()
	cp.summaryEnabled = false // skip the LLM tier; we want the regex tail
	b.compactIfNeeded(context.Background(), run, conv, RunHooks{}, 200_000, 100_000, cp)

	if !conversation.IsCompactBoundary(conv.Messages[0]) {
		t.Fatalf("first message after compaction is not a compact_boundary: %+v", conv.Messages[0])
	}

	boundaryCount := 0
	for _, m := range conv.Messages {
		if conversation.IsCompactBoundary(m) {
			boundaryCount++
		}
	}
	if boundaryCount != 1 {
		t.Errorf("expected exactly 1 boundary block, got %d", boundaryCount)
	}

	blocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[0].Trigger != "auto" {
		t.Errorf("boundary.Trigger = %q, want auto", blocks[0].Trigger)
	}
	if blocks[0].MessagesBefore == 0 {
		t.Error("boundary.MessagesBefore should be populated")
	}

	// Same legacy-prose absence checks as the reactive test — the
	// runloop must NEVER emit the old AddTransientUserMessage notices,
	// regardless of which compaction trigger fires.
	for _, m := range conv.Messages {
		if conversation.IsCompactBoundary(m) {
			continue
		}
		if s, ok := m.Content.(string); ok && strings.Contains(s, "[SYSTEM] Context compaction") {
			t.Errorf("legacy [SYSTEM] Context compaction transient still present: %q", s)
		}
		if blocks, ok := m.Content.([]types.LlmContentBlock); ok {
			for _, blk := range blocks {
				if strings.Contains(blk.Text, "[SYSTEM] Context compaction") {
					t.Errorf("legacy [SYSTEM] Context compaction transient still present in block: %q", blk.Text)
				}
				if strings.Contains(blk.Text, "[Post-compaction context restore]") {
					t.Errorf("legacy [Post-compaction context restore] block still present: %q", blk.Text)
				}
				if strings.Contains(blk.Text, "[Extracted facts from compacted context]") {
					t.Errorf("legacy [Extracted facts from compacted context] block still present: %q", blk.Text)
				}
			}
		}
	}
}

// TestCompactIfNeeded_HookPathReceivesAutoStrategy pins the
// proactive-path counterpart to
// TestCompactReactive_HookPathShortCircuitsRegex's strategy assertion.
// compactIfNeeded must pass strategy="auto" to OnRequestCompactSummary,
// or harness summarisers that branch on strategy will misfire.
func TestCompactIfNeeded_HookPathReceivesAutoStrategy(t *testing.T) {
	b := NewApiBackend()
	_ = captureEvents(b, "proactive-hook-strategy")

	conv := conversation.CreateConversation("proactive-hook-strategy", "", "test-model")
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: "We decided to use Go."},
	)
	for i := 0; i < 22; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "filler q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "filler a"})
	}
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = len(conv.Messages)

	gotStrategy := ""
	hookCalls := 0
	const hookSummary = "auto-strategy hook summary"
	hooks := RunHooks{
		OnRequestCompactSummary: func(_ string, strategy string, _ []types.LlmMessage) (string, bool) {
			hookCalls++
			gotStrategy = strategy
			return hookSummary, true
		},
	}

	run := &activeRun{requestID: "proactive-hook-strategy", conv: conv}
	cp := testCP()
	cp.summaryEnabled = false
	b.compactIfNeeded(context.Background(), run, conv, hooks, 200_000, 100_000, cp)

	if hookCalls != 1 {
		t.Errorf("expected OnRequestCompactSummary to be called once, got %d", hookCalls)
	}
	if gotStrategy != "auto" {
		t.Errorf("hook received strategy=%q, want %q (compactIfNeeded must always pass \"auto\")", gotStrategy, "auto")
	}

	blocks, _ := conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[0].Summary != hookSummary {
		t.Errorf("boundary.Summary = %q, want harness-supplied %q", blocks[0].Summary, hookSummary)
	}
}
