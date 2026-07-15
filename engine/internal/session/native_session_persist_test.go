package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestPersistCliTurn_AppendsToIonTranscript pins the continuity core: a
// delegated-CLI turn's user prompt + assistant text are appended to Ion's
// conversation store, advancing the leaf, so a later cross-provider turn's
// transcript bridge can carry them.
func TestPersistCliTurn_AppendsToIonTranscript(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("persist-turn", defaultConfig())

	const convID = "1784000000000-aaaaaaaaaaaa"
	mgr.mu.Lock()
	s := mgr.sessions["persist-turn"]
	s.conversationID = convID
	s.pendingCliUserTurn = "what is the capital of France?"
	s.pendingCliAssistantText = "Paris."
	mgr.mu.Unlock()

	mgr.persistCliTurn("persist-turn", convID)

	// Pending fields cleared so a later exit cannot double-append.
	mgr.mu.RLock()
	u, a := s.pendingCliUserTurn, s.pendingCliAssistantText
	mgr.mu.RUnlock()
	if u != "" || a != "" {
		t.Fatalf("pending turn not cleared: user=%q assistant=%q", u, a)
	}

	// The Ion transcript now contains the turn.
	msgs, err := conversation.LoadMessages(convID, "")
	if err != nil {
		t.Fatalf("load messages: %v", err)
	}
	var haveUser, haveAssistant bool
	for _, m := range msgs {
		if m.Role == "user" && strings.Contains(m.Content, "capital of France") {
			haveUser = true
		}
		if m.Role == "assistant" && strings.Contains(m.Content, "Paris.") {
			haveAssistant = true
		}
	}
	if !haveUser || !haveAssistant {
		t.Fatalf("persisted turn missing from Ion transcript: user=%v assistant=%v (%d msgs)", haveUser, haveAssistant, len(msgs))
	}
}

// TestPersistCliTurn_NoopForEngineOwned verifies an engine-owned run (empty
// pendingCliUserTurn — the ApiBackend persists its own turns) writes nothing.
func TestPersistCliTurn_NoopForEngineOwned(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewApiBackend())
	_, _ = mgr.StartSession("noop-owned", defaultConfig())

	const convID = "1784000000000-bbbbbbbbbbbb"
	mgr.mu.Lock()
	mgr.sessions["noop-owned"].conversationID = convID
	// pendingCliUserTurn intentionally empty (engine-owned run).
	mgr.mu.Unlock()

	mgr.persistCliTurn("noop-owned", convID)

	if conversation.Exists(convID, "") {
		t.Fatal("engine-owned run must not create an Ion conversation file")
	}
}

// TestCliTurnPersistence_RestoresCrossProviderContinuity is the end-to-end
// regression for the reported bug: a claude turn's content must be visible to
// a subsequent (cross-provider) turn's transcript bridge. Before the fix, the
// CLI turn never landed in Ion's store, so the next provider bridged an empty
// transcript and lost the prior turn.
func TestCliTurnPersistence_RestoresCrossProviderContinuity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("xprov", defaultConfig())

	const convID = "1784000000000-cccccccccccc"
	mgr.mu.Lock()
	s := mgr.sessions["xprov"]
	s.conversationID = convID
	mgr.mu.Unlock()

	// Turn 1 (claude): stash as prompt_dispatch would, then persist as
	// handleRunExit would.
	mgr.mu.Lock()
	s.runCaps = backend.NewClaudeCodeBackend().Capabilities()
	s.pendingCliUserTurn = "remember the secret code is BLUEBIRD"
	s.pendingCliAssistantText = "Understood, the secret code is BLUEBIRD."
	mgr.mu.Unlock()
	mgr.persistCliTurn("xprov", convID)

	// Turn 2 (a different provider): its bridge must carry turn 1's content.
	// Simulate the stale-cursor bridge path directly.
	opts := types.RunOptions{Model: "gpt-5-codex", Prompt: "what was the secret code?"}
	mgr.seedCliHistory(s, &opts)

	if !strings.Contains(opts.Prompt, "BLUEBIRD") {
		t.Fatalf("cross-provider bridge lost the prior claude turn: %q", opts.Prompt)
	}
	if !strings.Contains(opts.Prompt, "<prior-conversation>") {
		t.Fatalf("expected a bridged transcript: %q", opts.Prompt)
	}
	if !strings.HasSuffix(opts.Prompt, "what was the secret code?") {
		t.Fatalf("current prompt must remain at the end: %q", opts.Prompt)
	}
}

// TestPersistCliTurn_CreatesFileForFirstTurn verifies the first CLI turn on a
// pre-minted conversation (no backing file yet) creates the Ion file rather
// than dropping the turn.
func TestPersistCliTurn_CreatesFileForFirstTurn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("first-turn", defaultConfig())

	const convID = "1784000000000-dddddddddddd"
	mgr.mu.Lock()
	s := mgr.sessions["first-turn"]
	s.conversationID = convID
	s.pendingCliUserTurn = "hello"
	s.pendingCliAssistantText = "hi there"
	mgr.mu.Unlock()

	if conversation.Exists(convID, "") {
		t.Fatal("precondition: conversation file should not exist yet")
	}
	mgr.persistCliTurn("first-turn", convID)
	if !conversation.Exists(convID, "") {
		t.Fatal("first CLI turn did not create the Ion conversation file")
	}
}
