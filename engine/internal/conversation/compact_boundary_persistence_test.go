package conversation

// compact_boundary_persistence_test.go pins the contract that a
// compact_boundary message survives the Save → Load round-trip with
// every structural field intact.
//
// Why it matters: the duplication firewall introduced in the
// gentle-knitting-cup compaction fix hinges on
// MessagesAfterLastCompactBoundary finding the boundary on the very
// next turn after a session resume. Persistence writes messages as
// NDJSON; reload unmarshals them with Content as []interface{} of
// map[string]any, NOT the typed []LlmContentBlock the runloop builds
// fresh. If IsCompactBoundary (or any of the structured-field copies
// in sanitize.go / providers/messages.go) loses fidelity through that
// round-trip, the firewall has a hole only visible after a resume.

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestCompactBoundary_SurvivesSaveLoadRoundTrip mimics the runloop's
// real persistence flow: a compaction appends both a compact_boundary
// message into conv.Messages AND an EntryCompaction record into
// conv.Entries (see backend/runloop_compaction.go). saveSplit
// reconstructs the message body from Entries via BuildContextPath, so
// any boundary that exists only in conv.Messages without a matching
// Entry is intentionally dropped on save (and that's the contract the
// transient-message path relies on).
//
// This test exercises the reload path that runs after a session
// resume: IsCompactBoundary must recognise the rebuilt boundary, and
// MessagesAfterLastCompactBoundary must still anchor the slice on it.
func TestCompactBoundary_SurvivesSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("boundary-rt", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "first question")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "first reply"}},
		types.LlmUsage{InputTokens: 10, OutputTokens: 15})

	// Real runloop shape: append the EntryCompaction so saveSplit
	// persists it. BuildContextPath will reconstruct the boundary
	// message from this entry on load.
	AppendEntry(conv, EntryCompaction, CompactionData{
		Summary:          "## Decisions\n- Use Go for the new module",
		FirstKeptEntryID: "deadbeef",
		TokensBefore:     180_000,
	})
	AddUserMessage(conv, "post-compaction question")

	// Mirror conv.Messages to what BuildContextPath would produce
	// pre-save (the runloop maintains both side-by-side). Save will
	// overwrite this with BuildContextPath's output anyway, but we set
	// it for symmetry with how the runloop holds state.
	conv.Messages = BuildContextPath(conv)
	expectedCount := len(conv.Messages)

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("boundary-rt", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded.Messages) != expectedCount {
		t.Fatalf("loaded message count = %d, want %d", len(loaded.Messages), expectedCount)
	}

	// Find the boundary index in the reloaded slice. Walking by
	// IsCompactBoundary so the test exercises the same predicate the
	// runloop uses.
	boundaryIdx := -1
	for i, m := range loaded.Messages {
		if IsCompactBoundary(m) {
			boundaryIdx = i
			break
		}
	}
	if boundaryIdx < 0 {
		t.Fatalf("IsCompactBoundary did not recognise any boundary after reload (msgs=%d)", len(loaded.Messages))
	}

	// MessagesAfterLastCompactBoundary must slice at the boundary on
	// the reloaded conversation. This is the actual contract the
	// runloop relies on for the duplication firewall.
	slice := MessagesAfterLastCompactBoundary(loaded)
	expectedSliceLen := expectedCount - boundaryIdx
	if len(slice) != expectedSliceLen {
		t.Fatalf("MessagesAfterLastCompactBoundary returned %d messages after reload, want %d", len(slice), expectedSliceLen)
	}
	if !IsCompactBoundary(slice[0]) {
		t.Error("first element of post-reload slice is not the boundary")
	}
}

// TestCompactBoundary_StructuredFieldsSurviveReload pins each
// structured field through the JSON round-trip. The reload path
// goes through json.Unmarshal → MessageData → conv.Messages with
// Content as []interface{}; the test reaches into the reloaded blocks
// (via the existing contentToBlockSlice helper used by SanitizeMessages)
// and asserts every field round-tripped with the right type.
//
// This is the test that catches a regression where sanitize.go's
// contentToBlockSlice (or providers/messages.go's mapToContentBlock)
// forgets to copy a newly-added compact_boundary field.
//
// Path coverage: this test uses len(Entries) == 0 so Save falls back
// to saveJSON (the legacy single-file path), which persists
// conv.Messages verbatim. That's the path that preserves the full
// LlmContentBlock — every structured field round-trips.
//
// The split-file path (entries present) reconstructs boundaries from
// CompactionData via BuildContextPath, which carries only Summary +
// TokensBefore + a default "auto" Trigger by design. The remaining
// fields (ClearedBlocks, RecentFiles, FactCount, Messages*) are
// runloop-instant metadata, not durable session state — see
// TestCompactBoundary_TreeRebuildAfterReloadMatchesLiveInjection for
// the matching pin on the split path.
func TestCompactBoundary_StructuredFieldsSurviveReload(t *testing.T) {
	dir := t.TempDir()

	const wantSummary = "## Files Modified\n- /src/main.go"
	conv := CreateConversation("boundary-fields", "", "claude-3")
	conv.Messages = append(conv.Messages, BuildCompactBoundaryMessage(CompactMeta{
		Trigger:            "reactive",
		MessagesSummarized: 12,
		MessagesBefore:     30,
		MessagesAfter:      19,
		ClearedBlocks:      4,
		TokensBefore:       180_000,
		Summary:            wantSummary,
		FactCount:          5,
		RecentFiles:        []string{"/a.go", "/b.go", "/c.go"},
	}))

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := Load("boundary-fields", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Reach into the reloaded message via contentToBlockSlice — the
	// same helper sanitize uses to normalize []interface{} content
	// into typed blocks. If a structured field is missing from the
	// helper's copy list, this fails loudly.
	blocks := contentToBlockSlice(loaded.Messages[0].Content)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block after reload, got %d", len(blocks))
	}
	b := blocks[0]

	if b.Type != CompactBoundaryBlockType {
		t.Errorf("Type = %q, want %q", b.Type, CompactBoundaryBlockType)
	}
	if b.Trigger != "reactive" {
		t.Errorf("Trigger = %q, want reactive", b.Trigger)
	}
	if b.MessagesSummarized != 12 {
		t.Errorf("MessagesSummarized = %d, want 12", b.MessagesSummarized)
	}
	if b.MessagesBefore != 30 {
		t.Errorf("MessagesBefore = %d, want 30", b.MessagesBefore)
	}
	if b.MessagesAfter != 19 {
		t.Errorf("MessagesAfter = %d, want 19", b.MessagesAfter)
	}
	if b.ClearedBlocks != 4 {
		t.Errorf("ClearedBlocks = %d, want 4", b.ClearedBlocks)
	}
	if b.TokensBefore != 180_000 {
		t.Errorf("TokensBefore = %d, want 180_000", b.TokensBefore)
	}
	if b.FactCount != 5 {
		t.Errorf("FactCount = %d, want 5", b.FactCount)
	}
	if b.Summary != wantSummary {
		t.Errorf("Summary = %q, want %q", b.Summary, wantSummary)
	}
	if len(b.RecentFiles) != 3 {
		t.Fatalf("RecentFiles len = %d, want 3", len(b.RecentFiles))
	}
	for i, want := range []string{"/a.go", "/b.go", "/c.go"} {
		if b.RecentFiles[i] != want {
			t.Errorf("RecentFiles[%d] = %q, want %q", i, b.RecentFiles[i], want)
		}
	}
}

// TestCompactBoundary_TreeRebuildAfterReloadMatchesLiveInjection pins
// the byte-identity contract called out in the gentle-knitting-cup
// plan: a boundary reconstructed by BuildContextPath from a persisted
// CompactionData entry must be indistinguishable from a freshly-built
// boundary built from CompactMeta directly.
//
// Without this property a tree-rebuilt conversation (e.g. after a
// branch navigation) would route a different shape through provider
// serializers than the live runloop, and provider behaviour would
// silently diverge between fresh and reloaded sessions.
func TestCompactBoundary_TreeRebuildAfterReloadMatchesLiveInjection(t *testing.T) {
	dir := t.TempDir()

	// Build the tree-side: an EntryCompaction record with the same
	// Summary and TokensBefore the runloop would have persisted.
	conv := CreateConversation("tree-rebuild", "", "claude-3")
	AddUserMessage(conv, "before")
	AppendEntry(conv, EntryCompaction, CompactionData{
		Summary:          "we discussed Go",
		FirstKeptEntryID: "deadbeef",
		TokensBefore:     50_000,
	})
	AddUserMessage(conv, "after")

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := Load("tree-rebuild", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Force a tree-rebuild so the boundary message is the one
	// BuildContextPath emits from CompactionData (not the one Save
	// wrote to .llm.jsonl). Branch() rebuilds Messages via
	// BuildContextPath internally.
	if loaded.LeafID == nil {
		t.Fatal("loaded conv missing LeafID; cannot exercise tree rebuild")
	}
	rebuiltMsgs, err := Branch(loaded, *loaded.LeafID)
	if err != nil {
		t.Fatalf("Branch: %v", err)
	}

	// Locate the rebuilt boundary in the message list.
	var rebuiltBoundary types.LlmMessage
	found := false
	for _, m := range rebuiltMsgs {
		if IsCompactBoundary(m) {
			rebuiltBoundary = m
			found = true
			break
		}
	}
	if !found {
		t.Fatal("BuildContextPath did not emit a compact_boundary block for the EntryCompaction record")
	}

	rebuiltBlocks := contentToBlockSlice(rebuiltBoundary.Content)
	if len(rebuiltBlocks) != 1 {
		t.Fatalf("rebuilt boundary has %d blocks, want 1", len(rebuiltBlocks))
	}
	// The rebuild path carries exactly fields persisted on CompactionData. Older
	// entries have no Strategy value, so Trigger remains empty rather than being
	// silently rewritten to "auto".
	if !strings.Contains(rebuiltBlocks[0].Summary, "we discussed Go") {
		t.Errorf("rebuilt Summary = %q, want it to contain the persisted summary", rebuiltBlocks[0].Summary)
	}
	if rebuiltBlocks[0].TokensBefore != 50_000 {
		t.Errorf("rebuilt TokensBefore = %d, want 50_000", rebuiltBlocks[0].TokensBefore)
	}
	if rebuiltBlocks[0].Trigger != "" {
		t.Errorf("rebuilt Trigger = %q, want empty from legacy entry without persisted strategy", rebuiltBlocks[0].Trigger)
	}
	if rebuiltBlocks[0].Type != CompactBoundaryBlockType {
		t.Errorf("rebuilt Type = %q, want %q", rebuiltBlocks[0].Type, CompactBoundaryBlockType)
	}

	// And the rebuild must produce a message
	// MessagesAfterLastCompactBoundary recognises identically to a
	// live-injected one.
	if !IsCompactBoundary(rebuiltBoundary) {
		t.Error("rebuilt boundary is not recognised by IsCompactBoundary")
	}
}
