package session

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/normalizer"
	"github.com/dsswift/ion/engine/internal/types"
)

// The claude 2.1.x stream-json frame, byte-for-byte in the shape the CLI's own
// constructor emits (verified against the shipped binary): a `system` frame
// with subtype compact_boundary and a camelCase compactMetadata object.
const compactBoundaryFrame = `{
	"type":"system",
	"subtype":"compact_boundary",
	"content":"Conversation compacted",
	"level":"info",
	"uuid":"b2b52389-6d2a-49f5-8dec-d81b02a75a02",
	"session_id":"7dc31f72-9e29-494f-a201-a5d22191e9d5",
	"compactMetadata":{"trigger":"auto","preTokens":841821,"messagesSummarized":292,"durationMs":4310}
}`

// TestNormalizeCompactBoundary_ProducesTypedEvent is the regression arm for
// the drop: normalizeSystem returned nil for every subtype except "init", so a
// delegated CLI could compact its own session and Ion never saw it.
func TestNormalizeCompactBoundary_ProducesTypedEvent(t *testing.T) {
	events := normalizer.Normalize(json.RawMessage(compactBoundaryFrame))
	var got *types.NativeCompactionEvent
	for i := range events {
		if nc, ok := events[i].Data.(*types.NativeCompactionEvent); ok {
			got = nc
		}
	}
	if got == nil {
		t.Fatal("compact_boundary frame produced no NativeCompactionEvent")
	}
	if got.Trigger != "auto" {
		t.Errorf("Trigger = %q, want %q", got.Trigger, "auto")
	}
	if got.PreTokens != 841821 {
		t.Errorf("PreTokens = %d, want 841821", got.PreTokens)
	}
	if got.MessagesSummarized != 292 {
		t.Errorf("MessagesSummarized = %d, want 292", got.MessagesSummarized)
	}
	if got.DurationMs != 4310 {
		t.Errorf("DurationMs = %d, want 4310", got.DurationMs)
	}
	if got.SessionID != "7dc31f72-9e29-494f-a201-a5d22191e9d5" {
		t.Errorf("SessionID = %q", got.SessionID)
	}
}

// A frame with no metadata still reports the compaction. The fact is the
// signal; the counts are decoration.
func TestNormalizeCompactBoundary_MetadataOptional(t *testing.T) {
	events := normalizer.Normalize(json.RawMessage(`{"type":"system","subtype":"compact_boundary"}`))
	found := false
	for i := range events {
		if _, ok := events[i].Data.(*types.NativeCompactionEvent); ok {
			found = true
		}
	}
	if !found {
		t.Fatal("a metadata-less compact_boundary must still report the compaction")
	}
}

// TestNativeCompaction_RecordedWithoutTruncatingTheTranscript is the
// load-bearing arm of the whole design. A delegated CLI's native session is a
// disposable cache over Ion's transcript, so when that cache compacts, Ion
// must record the fact and keep every message. Recording it as an
// EntryCompaction instead would clear the context path and let the provider's
// cache eviction delete Ion's archive — the next cross-provider turn would
// bridge a conversation missing its first half.
func TestNativeCompaction_RecordedWithoutTruncatingTheTranscript(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID = "native-compact", "1784000000020-aaaaaaaaaaaa"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// An earlier completed turn that must survive the compaction.
	conv := conversation.CreateConversation(convID, "", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "the first question")
	conversation.AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: "the first answer"}}, "claude-sonnet-4-6")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	rec := newCliTranscriptRecorder()
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.pendingCliUserTurn = "the second question"
	s.cliTranscript = rec
	mgr.mu.Unlock()

	// The CLI answers, compacts mid-turn, then answers again.
	rec.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "working on it"}})
	rec.record(types.NormalizedEvent{Data: &types.NativeCompactionEvent{
		Trigger: "auto", PreTokens: 841821, MessagesSummarized: 292,
	}})
	rec.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "the second answer"}})

	mgr.persistCliTurn(key, convID)

	reloaded, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// The marker is in the tree, under the non-truncating entry type.
	var marker *conversation.SessionEntry
	for i := range reloaded.Entries {
		if reloaded.Entries[i].Type == conversation.EntryNativeCompaction {
			marker = &reloaded.Entries[i]
		}
		if reloaded.Entries[i].Type == conversation.EntryCompaction {
			t.Fatal("a native compaction was recorded as EntryCompaction — that truncates Ion's context path")
		}
	}
	if marker == nil {
		t.Fatal("no EntryNativeCompaction recorded for the CLI's compaction")
	}

	// Nothing was truncated: the pre-compaction turn is still in the context
	// path the next provider would be bridged.
	path := conversation.BuildContextPath(reloaded)
	// Content round-trips through JSON on reload, so match on the serialized
	// path rather than asserting a live block type.
	rendered, err := json.Marshal(path)
	if err != nil {
		t.Fatalf("marshal context path: %v", err)
	}
	foundFirst := strings.Contains(string(rendered), "the first answer")
	if !foundFirst {
		t.Fatalf("the pre-compaction turn was dropped from the context path (%d messages) — Ion's transcript must survive a provider-side cache eviction", len(path))
	}
}

// The marker reaches clients as a compaction row carrying the "native"
// strategy, which is what tells a consumer Ion's own history was not cut.
func TestNativeCompaction_ProjectsAsNativeStrategyMarker(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const convID = "1784000000021-bbbbbbbbbbbb"
	conv := conversation.CreateConversation(convID, "", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "hello")
	conversation.AppendEntry(conv, conversation.EntryNativeCompaction, conversation.NativeCompactionData{
		Trigger: "manual", PreTokens: 12345,
	})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	msgs, err := conversation.LoadMessages(convID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	for _, m := range msgs {
		if m.MarkerKind != "compaction" {
			continue
		}
		if m.MarkerStrategy != "native" {
			t.Errorf("MarkerStrategy = %q, want %q", m.MarkerStrategy, "native")
		}
		if m.MarkerTrigger != "manual" || m.MarkerPreTokens != 12345 {
			t.Errorf("marker detail lost: trigger=%q preTokens=%d", m.MarkerTrigger, m.MarkerPreTokens)
		}
		return
	}
	t.Fatalf("no compaction marker row projected for the native compaction (%d rows)", len(msgs))
}
