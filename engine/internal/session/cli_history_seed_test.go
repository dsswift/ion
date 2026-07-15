package session

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestBuildCliHistoryTranscript_FormatAndOrder(t *testing.T) {
	msgs := []types.SessionMessage{
		{Role: "user", Content: "first question"},
		{Role: "assistant", Content: "first answer"},
		{Role: "user", Content: "second question"},
	}
	tr := buildCliHistoryTranscript(msgs, cliHistoryTranscriptMaxBytes)
	if !strings.Contains(tr, "<prior-conversation>") || !strings.Contains(tr, "</prior-conversation>") {
		t.Fatalf("missing wrapper: %q", tr)
	}
	// Chronological order preserved.
	iFirst := strings.Index(tr, "first question")
	iAns := strings.Index(tr, "first answer")
	iSecond := strings.Index(tr, "second question")
	if iFirst >= iAns || iAns >= iSecond {
		t.Fatalf("messages out of order: %q", tr)
	}
	if !strings.Contains(tr, "[user]: first question") || !strings.Contains(tr, "[assistant]: first answer") {
		t.Fatalf("role formatting wrong: %q", tr)
	}
}

func TestBuildCliHistoryTranscript_SkipsInternalAndEmpty(t *testing.T) {
	msgs := []types.SessionMessage{
		{Role: "user", Content: "keep me"},
		{Role: "assistant", Content: "internal note", Internal: true},
		{Role: "assistant", Content: "   "},
		{Role: "assistant", Content: "", ToolName: "Read"},
	}
	tr := buildCliHistoryTranscript(msgs, cliHistoryTranscriptMaxBytes)
	if strings.Contains(tr, "internal note") {
		t.Fatal("internal row leaked into transcript")
	}
	if !strings.Contains(tr, "keep me") {
		t.Fatal("substantive row dropped")
	}
	if !strings.Contains(tr, "(used tool: Read)") {
		t.Fatalf("tool row not summarized: %q", tr)
	}
}

func TestBuildCliHistoryTranscript_TruncatesRecentBiased(t *testing.T) {
	var msgs []types.SessionMessage
	for i := 0; i < 50; i++ {
		msgs = append(msgs, types.SessionMessage{Role: "user", Content: strings.Repeat("x", 100) + "-old"})
	}
	msgs = append(msgs, types.SessionMessage{Role: "user", Content: "the-newest-message"})
	tr := buildCliHistoryTranscript(msgs, 512)
	if !strings.Contains(tr, "the-newest-message") {
		t.Fatal("truncation dropped the newest message")
	}
	if !strings.Contains(tr, "[earlier turns omitted]") {
		t.Fatalf("expected truncation marker: %q", tr)
	}
	if len(tr) > 2048 {
		t.Fatalf("transcript not bounded: %d bytes", len(tr))
	}
}

func TestBuildCliHistoryTranscript_EmptyWhenNothingSubstantive(t *testing.T) {
	msgs := []types.SessionMessage{
		{Role: "assistant", Content: "x", Internal: true},
		{Role: "user", Content: "  "},
	}
	if tr := buildCliHistoryTranscript(msgs, cliHistoryTranscriptMaxBytes); tr != "" {
		t.Fatalf("expected empty transcript, got %q", tr)
	}
}

// writeSeedConv persists a two-turn conversation under $HOME/.ion/conversations
// so LoadMessages(id, "") resolves it. Returns the conversation's LeafID so
// cursor-validity tests can tag cursors against the live head.
func writeSeedConv(t *testing.T, id string) string {
	t.Helper()
	conv := conversation.CreateConversation(id, "system", "claude-opus-4-8")
	conversation.AddUserMessage(conv, "what is the capital of France?")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Paris."}}, types.LlmUsage{})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conv: %v", err)
	}
	if conv.LeafID == nil {
		t.Fatal("seed conversation has no leaf")
	}
	return *conv.LeafID
}

// advanceSeedConv appends one more turn to a persisted conversation and saves,
// moving its LeafID — the "another provider advanced the transcript" case.
func advanceSeedConv(t *testing.T, id string) {
	t.Helper()
	conv, err := conversation.Load(id, "")
	if err != nil {
		t.Fatalf("load conv: %v", err)
	}
	conversation.AddUserMessage(conv, "an intervening turn on another provider")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conv: %v", err)
	}
}

func TestResolveCliContinuity_BridgesWhenNoCursor(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	_ = filepath.Join(home, ".ion", "conversations") // created by Save
	writeSeedConv(t, "seedconv-1")

	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := &engineSession{key: "k1", conversationID: "seedconv-1"}
	opts := types.RunOptions{Model: "claude-opus-4-8", Prompt: "and its population?"}

	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "" {
		t.Fatalf("no cursor exists, resume must stay empty, got %q", opts.CliResumeSessionID)
	}
	if !strings.Contains(opts.Prompt, "<prior-conversation>") {
		t.Fatalf("history not seeded into CLI prompt: %q", opts.Prompt)
	}
	if !strings.Contains(opts.Prompt, "Paris.") || !strings.Contains(opts.Prompt, "capital of France") {
		t.Fatalf("prior turns missing from seed: %q", opts.Prompt)
	}
	if !strings.HasSuffix(opts.Prompt, "and its population?") {
		t.Fatalf("current prompt must remain at the end: %q", opts.Prompt)
	}
}

func TestResolveCliContinuity_ResumesOnValidCursor(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	leaf := writeSeedConv(t, "seedconv-2")

	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := &engineSession{key: "k2", conversationID: "seedconv-2",
		nativeSessions: map[string]conversation.NativeSessionCursor{
			"claude-code": {Cursor: "claude-uuid-abc", HeadEntryID: leaf},
		}}
	opts := types.RunOptions{Model: "claude-opus-4-8", Prompt: "follow up"}

	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "claude-uuid-abc" {
		t.Fatalf("valid cursor must resume natively, got %q", opts.CliResumeSessionID)
	}
	if opts.Prompt != "follow up" {
		t.Fatalf("resumable CLI session must not be seeded: %q", opts.Prompt)
	}
}

func TestResolveCliContinuity_BridgesOnStaleCursor(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	leaf := writeSeedConv(t, "seedconv-3")
	// Another writer (e.g. an ApiBackend turn) advances the transcript,
	// staling the cursor captured at the old head.
	advanceSeedConv(t, "seedconv-3")

	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := &engineSession{key: "k3", conversationID: "seedconv-3",
		nativeSessions: map[string]conversation.NativeSessionCursor{
			"claude-code": {Cursor: "claude-uuid-abc", HeadEntryID: leaf},
		}}
	opts := types.RunOptions{Model: "claude-opus-4-8", Prompt: "next"}

	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "" {
		t.Fatalf("stale cursor must not resume, got %q", opts.CliResumeSessionID)
	}
	if !strings.Contains(opts.Prompt, "<prior-conversation>") {
		t.Fatalf("stale cursor must bridge from the transcript: %q", opts.Prompt)
	}
	if !strings.Contains(opts.Prompt, "intervening turn on another provider") {
		t.Fatalf("bridge must carry the intervening turn: %q", opts.Prompt)
	}
}

func TestResolveCliContinuity_ResumesCliOnlyConversationWithoutFile(t *testing.T) {
	// A CLI-only conversation never writes the Ion store, so there is no
	// backing file and the live leaf reads as "". A cursor captured at that
	// same state (HeadEntryID == "") is still valid — consecutive CLI turns
	// must resume natively, not re-bridge an empty transcript.
	home := t.TempDir()
	t.Setenv("HOME", home)

	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := &engineSession{key: "k4", conversationID: "cli-only-no-file",
		nativeSessions: map[string]conversation.NativeSessionCursor{
			"claude-code": {Cursor: "claude-uuid-xyz", HeadEntryID: ""},
		}}
	opts := types.RunOptions{Model: "claude-opus-4-8", Prompt: "again"}

	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "claude-uuid-xyz" {
		t.Fatalf("fileless CLI-only conversation must resume its cursor, got %q", opts.CliResumeSessionID)
	}
	if opts.Prompt != "again" {
		t.Fatalf("prompt must be untouched on resume: %q", opts.Prompt)
	}
}

func TestResolveCliContinuity_NoopForApiBackend(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeSeedConv(t, "seedconv-5")

	mgr := NewManager(backend.NewApiBackend())
	s := &engineSession{key: "k5", conversationID: "seedconv-5"}
	opts := types.RunOptions{Model: "claude-opus-4-8", Prompt: "hello"}

	mgr.resolveCliContinuity(s, &opts)

	if opts.Prompt != "hello" || opts.CliResumeSessionID != "" {
		t.Fatalf("api backend must not be seeded or resumed (it loads history itself): %q %q", opts.Prompt, opts.CliResumeSessionID)
	}
}
