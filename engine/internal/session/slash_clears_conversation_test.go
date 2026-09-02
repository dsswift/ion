package session

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// writeCommandTemplate drops a slash-command template into the session's
// working-directory command root so resolveSlashCommand finds it.
func writeCommandTemplate(t *testing.T, workingDir, name, body string) {
	t.Helper()
	dir := filepath.Join(workingDir, ".ion", "commands")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir command root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".md"), []byte(body), 0o644); err != nil {
		t.Fatalf("write template %s: %v", name, err)
	}
}

// TestFrontmatterClearsConversation pins the parse contract for the
// clears-conversation key, including the fail-closed rule: only an affirmative
// value arms a destructive behavior.
func TestFrontmatterClearsConversation(t *testing.T) {
	cases := []struct {
		name string
		fm   map[string]any
		want bool
	}{
		{"absent", map[string]any{}, false},
		{"parsed bool true", map[string]any{"clears-conversation": true}, true},
		{"parsed bool false", map[string]any{"clears-conversation": false}, false},
		{"string true", map[string]any{"clears-conversation": "true"}, true},
		{"string yes", map[string]any{"clears-conversation": "yes"}, true},
		{"string false", map[string]any{"clears-conversation": "false"}, false},
		{"underscore alias", map[string]any{"clears_conversation": true}, true},
		// A typo must not arm the clear. Failing closed is the whole point:
		// the cost of a missed clear is an inherited context, the cost of a
		// spurious clear is a destroyed conversation.
		{"unrecognized value fails closed", map[string]any{"clears-conversation": "sure"}, false},
		{"nil value fails closed", map[string]any{"clears-conversation": nil}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := frontmatterBool(tc.fm, "clears-conversation", "clears_conversation"); got != tc.want {
				t.Errorf("frontmatterBool = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestResolveSlashCommandClearsConversation proves the key survives the real
// template-resolution path, not just the helper.
func TestResolveSlashCommandClearsConversation(t *testing.T) {
	workingDir := t.TempDir()
	writeCommandTemplate(t, workingDir, "squash", "---\nmodel: fast\nclears-conversation: true\n---\nSquash the branch.\n")
	writeCommandTemplate(t, workingDir, "recap", "---\ndescription: recap\n---\nRecap the conversation.\n")

	t.Run("declared key resolves true alongside the model tier", func(t *testing.T) {
		res, ok := resolveSlashCommand("squash", "", workingDir, false)
		if !ok {
			t.Fatal("squash template did not resolve")
		}
		if !res.ClearsConversation {
			t.Error("ClearsConversation = false, want true")
		}
		if res.Model != "fast" {
			t.Errorf("Model = %q, want fast: the two keys must both survive resolution", res.Model)
		}
	})

	t.Run("undeclared key resolves false", func(t *testing.T) {
		res, ok := resolveSlashCommand("recap", "", workingDir, false)
		if !ok {
			t.Fatal("recap template did not resolve")
		}
		if res.ClearsConversation {
			t.Error("ClearsConversation = true, want false for a template that declares nothing")
		}
	})
}

// TestListSlashCommandsPublishesClearsConversation pins the discovery-feed
// field. This is the field a client reads to warn the operator BEFORE sending
// the prompt, so losing it silently removes the confirmation.
func TestListSlashCommandsPublishesClearsConversation(t *testing.T) {
	workingDir := t.TempDir()
	writeCommandTemplate(t, workingDir, "squash", "---\ndescription: squash\nclears-conversation: true\n---\nSquash.\n")
	writeCommandTemplate(t, workingDir, "recap", "---\ndescription: recap\n---\nRecap.\n")

	listings := discoverSlashCommands(workingDir, false)

	found := map[string]bool{}
	for _, l := range listings {
		found[l.Name] = l.ClearsConversation
	}

	if got, ok := found["squash"]; !ok {
		t.Fatal("squash missing from the discovery feed")
	} else if !got {
		t.Error("squash ClearsConversation = false on the feed, want true")
	}
	if got, ok := found["recap"]; !ok {
		t.Fatal("recap missing from the discovery feed")
	} else if got {
		t.Error("recap ClearsConversation = true on the feed, want false")
	}
}

func TestApplySlashClearsConversationAbortsOnDurableFailure(t *testing.T) {
	const key = "clear-failure"
	conv := conversation.CreateConversation(conversation.NewConversationID(), "", "current-model")
	conversation.AddUserMessage(conv, "prior context")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}

	s := &engineSession{
		key: key, conversationID: conv.ID, lastContextPct: 70, lastContextTokens: 700,
		lastPermissionDenials: []types.PermissionDenial{{ToolName: "AskUserQuestion"}},
	}
	mgr := &Manager{sessions: map[string]*engineSession{key: s}}
	clearErr := errors.New("disk unavailable")
	cleared, err := mgr.applySlashClearsConversationWith(s, key, &ResolvedSlash{
		Command: "/review", ClearsConversation: true,
	}, func(string) (clearResult, error) {
		return clearResult{}, clearErr
	})
	if err == nil || !errors.Is(err, clearErr) || cleared {
		t.Fatalf("result = (%t, %v), want failed precondition", cleared, err)
	}
	if s.lastContextPct != 70 || s.lastContextTokens != 700 || len(s.lastPermissionDenials) != 1 {
		t.Fatalf("live state mutated after failed durable clear: pct=%d tokens=%d denials=%d", s.lastContextPct, s.lastContextTokens, len(s.lastPermissionDenials))
	}
	loaded, loadErr := conversation.Load(conv.ID, "")
	if loadErr != nil {
		t.Fatalf("Load conversation: %v", loadErr)
	}
	if !conversation.HasModelVisibleHistory(loaded) {
		t.Fatal("durable history was cleared after failed precondition")
	}
}

func TestSendPromptClearingCommandFailureDoesNotStartBackend(t *testing.T) {
	workingDir := t.TempDir()
	writeCommandTemplate(t, workingDir, "review", "---\nclears-conversation: true\n---\nReview.\n")
	conv := conversation.CreateConversation(conversation.NewConversationID(), "", "current-model")
	conversation.AddUserMessage(conv, "prior context")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}

	conversationDir := conversation.DefaultConversationsDir()
	llmPath := filepath.Join(conversationDir, conv.ID+".llm.jsonl")
	llmBackup := llmPath + ".test-backup"
	if err := os.Rename(llmPath, llmBackup); err != nil {
		t.Fatalf("move conversation file: %v", err)
	}
	if err := os.Mkdir(llmPath, 0o755); err != nil {
		t.Fatalf("replace conversation file with directory: %v", err)
	}
	restored := false
	t.Cleanup(func() {
		if restored {
			return
		}
		_ = os.Remove(llmPath)
		_ = os.Rename(llmBackup, llmPath)
	})

	backend := newMockBackend()
	mgr := NewManager(backend)
	events := newEventCollector(mgr)
	const key = "clear-failure-dispatch"
	if _, err := mgr.StartSession(key, types.EngineConfig{
		ProfileID: "test", WorkingDirectory: workingDir, SessionID: conv.ID,
	}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	err := mgr.SendPrompt(key, "/review", &PromptOverrides{ResolveSlash: true})
	if err == nil || !strings.Contains(err.Error(), "requires a fresh conversation") {
		t.Fatalf("SendPrompt error = %v, want clear precondition failure", err)
	}
	if len(backend.startedKeys()) != 0 {
		t.Fatal("backend started after required clear failed")
	}
	results := events.byType("engine_command_result")
	if len(results) != 1 || !strings.Contains(results[0].event.CommandError, "requires a fresh conversation") {
		t.Fatalf("command results = %+v, want one clear-precondition failure", results)
	}
	if err := os.Remove(llmPath); err != nil {
		t.Fatalf("remove failure directory: %v", err)
	}
	if err := os.Rename(llmBackup, llmPath); err != nil {
		t.Fatalf("restore conversation file: %v", err)
	}
	restored = true
	loaded, loadErr := conversation.Load(conv.ID, "")
	if loadErr != nil || !conversation.HasModelVisibleHistory(loaded) {
		t.Fatalf("prior history changed after failed clear: loadErr=%v", loadErr)
	}
}

// TestSendCommandClearsConversationStartsRun is the end-to-end regression test
// for the mutex self-deadlock in the clears-conversation command path. The
// command must pass through SendCommand, SendPrompt, the pre-run clear, and into
// the backend. A timeout means dispatch stopped before StartRun.
func TestSendCommandClearsConversationStartsRun(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workingDir := t.TempDir()
	writeCommandTemplate(t, workingDir, "squash", "---\nclears-conversation: true\n---\nSquash the branch.\n")

	backend := newMockBackend()
	mgr := NewManager(backend)
	events := newEventCollector(mgr)
	const key = "clears-conversation-command"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test", WorkingDirectory: workingDir}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	done := make(chan struct{})
	go func() {
		mgr.SendCommand(key, "squash", "")
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for len(backend.startedKeys()) == 0 {
		select {
		case <-deadline:
			t.Fatal("clears-conversation command did not start a run")
		case <-time.After(time.Millisecond):
		}
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SendCommand deadlocked after starting the command run")
	}

	deadline = time.After(2 * time.Second)
	for {
		results := events.byType("engine_command_result")
		if len(results) == 1 {
			if results[0].event.Command != "squash" || results[0].event.CommandError != "" {
				t.Fatalf("command result = %+v, want successful squash", results[0].event)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatalf("command did not emit one result after dispatch; got %d", len(results))
		case <-time.After(time.Millisecond):
		}
	}
}
