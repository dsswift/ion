package compaction

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestBuildCompactBoundaryMessage verifies that BuildCompactBoundaryMessage
// emits a single typed compact_boundary block carrying every field from
// the CompactMeta input. This is the contract every call site (the
// runloop, the tree-rebuild path, the manual CompactWithSummary path)
// depends on: identical wire shape regardless of trigger.
func TestBuildCompactBoundaryMessage(t *testing.T) {
	meta := CompactMeta{
		Trigger:            "auto",
		MessagesSummarized: 12,
		MessagesBefore:     30,
		MessagesAfter:      19,
		ClearedBlocks:      4,
		TokensBefore:       180_000,
		Summary:            "we discussed compaction",
		FactCount:          5,
		RecentFiles:        []string{"/a.go", "/b.go"},
	}

	msg := BuildCompactBoundaryMessage(meta)
	if msg.Role != "user" {
		t.Errorf("Role = %q, want user", msg.Role)
	}

	blocks, ok := msg.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("Content type = %T, want []LlmContentBlock", msg.Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}
	b := blocks[0]
	if b.Type != conversation.CompactBoundaryBlockType {
		t.Errorf("block.Type = %q, want %q", b.Type, conversation.CompactBoundaryBlockType)
	}
	if b.Trigger != meta.Trigger {
		t.Errorf("block.Trigger = %q, want %q", b.Trigger, meta.Trigger)
	}
	if b.MessagesSummarized != meta.MessagesSummarized ||
		b.MessagesBefore != meta.MessagesBefore ||
		b.MessagesAfter != meta.MessagesAfter ||
		b.ClearedBlocks != meta.ClearedBlocks ||
		b.TokensBefore != meta.TokensBefore ||
		b.FactCount != meta.FactCount {
		t.Errorf("block metadata mismatch: %+v vs meta %+v", b, meta)
	}
	if b.Summary != meta.Summary {
		t.Errorf("block.Summary = %q, want %q", b.Summary, meta.Summary)
	}
	if len(b.RecentFiles) != len(meta.RecentFiles) {
		t.Fatalf("block.RecentFiles len = %d, want %d", len(b.RecentFiles), len(meta.RecentFiles))
	}
	for i, f := range b.RecentFiles {
		if f != meta.RecentFiles[i] {
			t.Errorf("block.RecentFiles[%d] = %q, want %q", i, f, meta.RecentFiles[i])
		}
	}
}

// TestBuildCompactBoundaryMessage_JSONRoundTrip pins the wire format —
// the boundary block must survive a JSON encode/decode cycle losslessly
// because persistence stores messages as NDJSON and the next session
// load round-trips them through json.Unmarshal into LlmMessage.
func TestBuildCompactBoundaryMessage_JSONRoundTrip(t *testing.T) {
	meta := CompactMeta{
		Trigger:        "reactive",
		MessagesBefore: 50,
		MessagesAfter:  20,
		ClearedBlocks:  3,
		Summary:        "test summary",
		FactCount:      2,
		RecentFiles:    []string{"/x.ts"},
	}
	msg := BuildCompactBoundaryMessage(meta)

	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded types.LlmMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// After JSON round-trip, content is []interface{} of map[string]any,
	// not []LlmContentBlock — that's how persistence reloads it. Verify
	// the new structured fields are present in the raw map shape so
	// downstream contentToBlockSlice / mapToContentBlock can hydrate.
	contentSlice, ok := decoded.Content.([]interface{})
	if !ok {
		t.Fatalf("decoded content type = %T, want []interface{}", decoded.Content)
	}
	if len(contentSlice) != 1 {
		t.Fatalf("decoded content len = %d, want 1", len(contentSlice))
	}
	m, ok := contentSlice[0].(map[string]interface{})
	if !ok {
		t.Fatalf("decoded block type = %T, want map[string]interface{}", contentSlice[0])
	}
	if m["type"] != conversation.CompactBoundaryBlockType {
		t.Errorf("decoded type = %v, want %q", m["type"], conversation.CompactBoundaryBlockType)
	}
	if m["summary"] != "test summary" {
		t.Errorf("decoded summary = %v, want 'test summary'", m["summary"])
	}
	if m["trigger"] != "reactive" {
		t.Errorf("decoded trigger = %v, want 'reactive'", m["trigger"])
	}
	// JSON numbers decode as float64 by default.
	if m["clearedBlocks"] != float64(3) {
		t.Errorf("decoded clearedBlocks = %v, want 3", m["clearedBlocks"])
	}
}

// TestExtractFacts_DedupeWithinPass pins fix for cause #3 in the
// gentle-knitting-cup plan: ExtractFacts must dedupe (Type, Content)
// pairs so a file path mentioned N times across messages contributes one
// bullet, not N.
func TestExtractFacts_DedupeWithinPass(t *testing.T) {
	isErr := false
	mkResult := func(text string) types.LlmMessage {
		return types.LlmMessage{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "x", Content: text, IsError: &isErr},
			},
		}
	}

	// Same path mentioned 5 times across separate messages — without
	// dedupe ExtractFacts would emit 5 file_mod entries.
	msgs := []types.LlmMessage{
		mkResult("Wrote to /src/foo.ts"),
		mkResult("Read /src/foo.ts again"),
		mkResult("Edited /src/foo.ts once more"),
		mkResult("Touched /src/foo.ts and /other.go"),
		mkResult("Last edit on /src/foo.ts"),
	}

	facts := ExtractFacts(msgs)
	count := 0
	for _, f := range facts {
		if f.Type == "file_mod" && f.Content == "/src/foo.ts" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected /src/foo.ts to appear once after dedupe, got %d", count)
	}
}

// TestFormatFactsSummary_CapAndOverflow verifies the per-section cap +
// overflow line introduced for cause #3. Feeding more than
// MaxFactsPerSection unique entries of one type must render the first
// MaxFactsPerSection then collapse the remainder into "... (+N more)".
func TestFormatFactsSummary_CapAndOverflow(t *testing.T) {
	const extra = 7
	facts := make([]Fact, 0, MaxFactsPerSection+extra)
	for i := 0; i < MaxFactsPerSection+extra; i++ {
		facts = append(facts, Fact{Type: "file_mod", Content: fmt.Sprintf("/path/%03d.go", i)})
	}

	summary := FormatFactsSummary(facts)

	// First entry must be present (head of list).
	if !strings.Contains(summary, "/path/000.go") {
		t.Error("expected first capped entry to appear")
	}
	// Last entry within the cap must be present.
	withinCap := fmt.Sprintf("/path/%03d.go", MaxFactsPerSection-1)
	if !strings.Contains(summary, withinCap) {
		t.Errorf("expected entry at cap edge (%s) to appear", withinCap)
	}
	// First entry over the cap must NOT be rendered (collapsed).
	beyondCap := fmt.Sprintf("/path/%03d.go", MaxFactsPerSection)
	if strings.Contains(summary, beyondCap) {
		t.Errorf("entry beyond cap (%s) should have been collapsed", beyondCap)
	}
	// Overflow line must report the correct excess count.
	overflow := fmt.Sprintf("... (+%d more)", extra)
	if !strings.Contains(summary, overflow) {
		t.Errorf("expected overflow line %q, got summary:\n%s", overflow, summary)
	}
}

// TestExtractFacts_EmptyOnBoundaryOnly verifies that feeding ExtractFacts
// a slice containing only a compact_boundary message returns no facts.
// In practice this is the input MessagesAfterLastCompactBoundary returns
// when no new messages have been appended since the last compaction. The
// regex extractor must not re-mine the prior summary text — the
// gentle-knitting-cup plan's duplication firewall.
func TestExtractFacts_EmptyOnBoundaryOnly(t *testing.T) {
	boundary := conversation.BuildCompactBoundaryMessage(conversation.CompactMeta{
		Trigger: "auto",
		// A summary that *contains* fact-extractor keywords. Without the
		// structural-skip property the regex would happily re-extract
		// "decided", "failed", and the file path.
		Summary: "We decided to use Go. The build failed at /src/main.go.",
	})
	facts := ExtractFacts([]types.LlmMessage{boundary})
	if len(facts) != 0 {
		// ExtractFacts itself walks message text and would happily
		// match — the firewall is at the caller layer (the runloop
		// passes MessagesAfterLastCompactBoundary, which starts at the
		// boundary). Inside the boundary the Summary field carries the
		// text but the block Type is "compact_boundary", not "text" or
		// "tool_result", so extractText returns "" and no patterns
		// match.
		//
		// Locking the behaviour here means a future refactor that
		// teaches extractText to walk the Summary field would trip
		// this test and force a conscious decision.
		t.Errorf("expected 0 facts from a boundary-only message, got %d:\n%+v", len(facts), facts)
	}
}
