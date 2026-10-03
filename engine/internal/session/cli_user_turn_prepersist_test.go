package session

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func countUserRows(t *testing.T, convID, needle string) int {
	t.Helper()
	msgs, err := conversation.LoadMessages(convID, "")
	if err != nil {
		t.Fatalf("load messages: %v", err)
	}
	n := 0
	for _, m := range msgs {
		if m.Role == "user" && strings.Contains(m.Content, needle) {
			n++
		}
	}
	return n
}

// A delegated-CLI run with run recovery OFF (the default) must still hand the
// backend the entry id of its user turn, so the run can announce it before
// streaming. Before this, the turn was written only at run exit: no id existed
// during the run, nothing was announced, and a client that had sent the turn
// rendered it twice after the next history load.
//
// Run with recovery on as well: the turn then comes from the journal commit,
// and every assertion below must hold identically.
func TestDispatch_DelegatedCliPrePersistsUserTurn(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		name := "recovery off"
		if recovery {
			name = "recovery on"
		}
		t.Run(name, func(t *testing.T) { runDelegatedCliPrePersist(t, recovery) })
	}
}

func runDelegatedCliPrePersist(t *testing.T, recovery bool) {
	t.Setenv("HOME", t.TempDir())
	mb := &nativeSessionMockBackend{mockBackend: newMockBackend()}
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.RunRecovery = &types.RunRecoveryConfig{Enabled: &recovery}
	_, _ = mgr.StartSession("cli-prepersist", cfg)

	const convID = "1784000000077-dddddddddddd"
	conv := conversation.CreateConversation(convID, "system", "claude-opus-4-8")
	conversation.AddUserMessage(conv, "what is the capital of France?")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Paris."}}, types.LlmUsage{})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save conv: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions["cli-prepersist"]
	s.conversationID = convID
	mgr.mu.Unlock()

	if err := mgr.SendPrompt("cli-prepersist", "and of Spain?", nil); err != nil {
		t.Fatalf("send prompt: %v", err)
	}

	mb.mu.Lock()
	var started types.RunOptions
	for _, opts := range mb.started {
		started = opts
	}
	mb.mu.Unlock()

	if started.PrePersistedUserEntryID == "" {
		t.Fatal("the backend must receive the persisted user turn's entry id")
	}
	if got := countUserRows(t, convID, "and of Spain?"); got != 1 {
		t.Fatalf("user turn must be on disk before the run starts, found %d", got)
	}
	// The dispatch-time write is the first write a delegated-CLI conversation
	// gets, and no API runloop follows it, so it must record where the
	// conversation runs. Directory-scoped consumers (worktree membership,
	// retros) cannot see a conversation whose header leaves this blank.
	if onDisk, err := conversation.Load(convID, ""); err != nil {
		t.Fatalf("load conversation: %v", err)
	} else if onDisk.WorkingDirectory != testWorkDir() {
		t.Fatalf("working directory must be recorded at dispatch, got %q", onDisk.WorkingDirectory)
	}
	// The history bridge ran (no native cursor). The turn is the prompt, so the
	// bridged transcript must not carry it a second time.
	if got := strings.Count(started.Prompt, "and of Spain?"); got != 1 {
		t.Fatalf("prompt must carry the user turn once, found %d in %q", got, started.Prompt)
	}
	if !strings.Contains(started.Prompt, "capital of France") {
		t.Fatalf("prior history must still be bridged, got %q", started.Prompt)
	}

	// Run exit appends the assistant output only.
	mgr.mu.Lock()
	s.pendingCliAssistantText = "Madrid."
	mgr.mu.Unlock()
	mgr.persistCliTurn("cli-prepersist", convID)

	if got := countUserRows(t, convID, "and of Spain?"); got != 1 {
		t.Fatalf("run exit must not append the user turn again, found %d", got)
	}
	msgs, _ := conversation.LoadMessages(convID, "")
	if last := msgs[len(msgs)-1]; last.Role != "assistant" || !strings.Contains(last.Content, "Madrid.") {
		t.Fatalf("assistant output must follow the user turn, last row = %s %q", last.Role, last.Content)
	}
}

// When the dispatch-time write produced no id, run exit still writes the turn.
func TestPersistCliTurn_WritesUserTurnWhenNotPrePersisted(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(&nativeSessionMockBackend{mockBackend: newMockBackend()})
	_, _ = mgr.StartSession("cli-fallback", defaultConfig())

	const convID = "1784000000078-eeeeeeeeeeee"
	mgr.mu.Lock()
	s := mgr.sessions["cli-fallback"]
	s.conversationID = convID
	s.pendingCliUserTurn = "fallback turn"
	s.pendingCliUserEntryID = ""
	s.pendingCliAssistantText = "ok"
	mgr.mu.Unlock()

	mgr.persistCliTurn("cli-fallback", convID)

	if got := countUserRows(t, convID, "fallback turn"); got != 1 {
		t.Fatalf("want the user turn written once at exit, found %d", got)
	}
}

func TestWithoutEntryDropsEveryRowOfThatEntry(t *testing.T) {
	msgs := []types.SessionMessage{{ID: "a"}, {ID: "b"}, {ID: "b:1"}, {ID: "bc"}}
	got := withoutEntry(msgs, "b")
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "bc" {
		t.Fatalf("got %+v", got)
	}
	if len(withoutEntry(msgs, "")) != len(msgs) {
		t.Fatal("an empty entry id must drop nothing")
	}
}
