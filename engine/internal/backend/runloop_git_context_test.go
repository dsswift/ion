package backend

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

const testGitContext = "# Git Context\nBranch: wt/example\nRecent commits:\nabc1234 fix(engine): something"

// TestAppendGitContextMessage_AppendsAfterHistory pins the core of the fix:
// git context arrives AFTER every existing message. Anthropic places its cache
// breakpoints on the system prompt and the trailing user messages, so a block
// appended past the history is outside the cached prefix and a repository
// change re-sends only that block.
//
// Regression guard: if git context is ever moved back into the system prompt or
// prepended ahead of history, it lands inside the cached prefix and one commit
// invalidates the entire conversation. This test fails in that case.
func TestAppendGitContextMessage_AppendsAfterHistory(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: "first"},
		{Role: "assistant", Content: "second"},
	}

	out := AppendGitContextMessage(msgs, types.RunOptions{GitContextText: testGitContext}, "run-1", 0)

	if len(out) != len(msgs)+1 {
		t.Fatalf("expected %d messages, got %d", len(msgs)+1, len(out))
	}
	last := out[len(out)-1]
	if last.Role != "user" {
		t.Errorf("git context message role = %q, want user", last.Role)
	}
	blocks, ok := last.Content.([]types.LlmContentBlock)
	if !ok || len(blocks) != 1 {
		t.Fatalf("expected one content block, got %#v", last.Content)
	}
	if !strings.Contains(blocks[0].Text, testGitContext) {
		t.Errorf("git context text missing from appended message: %q", blocks[0].Text)
	}
	// The pre-existing history must be untouched and still ordered.
	if out[0].Content != "first" || out[1].Content != "second" {
		t.Error("existing history was reordered or mutated")
	}
}

// TestAppendGitContextMessage_IsTransient pins that the injected message never
// reaches durable history. The run loop rebuilds it from RunOptions on every
// turn, so persisting it would replay stale repository state into later turns.
func TestAppendGitContextMessage_IsTransient(t *testing.T) {
	out := AppendGitContextMessage(nil, types.RunOptions{GitContextText: testGitContext}, "run-1", 0)
	if len(out) != 1 {
		t.Fatalf("expected 1 message, got %d", len(out))
	}
	if !out[0].Transient {
		t.Error("git context message must be Transient so it is never persisted")
	}
	if out[0].EntryID != "" {
		t.Errorf("git context message must have no tree entry, got EntryID %q", out[0].EntryID)
	}
}

// TestAppendGitContextMessage_NoContextIsNoOp verifies a run without git
// context (non-repo cwd, git timeout) sends the history unchanged rather than
// an empty reminder block.
func TestAppendGitContextMessage_NoContextIsNoOp(t *testing.T) {
	msgs := []types.LlmMessage{{Role: "user", Content: "only"}}

	out := AppendGitContextMessage(msgs, types.RunOptions{}, "run-1", 0)

	if len(out) != 1 {
		t.Fatalf("expected history unchanged, got %d messages", len(out))
	}
	if out[0].Content != "only" {
		t.Error("history mutated when no git context was present")
	}
}

// TestAppendGitContextMessage_DoesNotMutateInput guards the caller's slice.
// The run loop passes a slice it also uses for the breakdown; appending in
// place could alias and corrupt it.
func TestAppendGitContextMessage_DoesNotMutateInput(t *testing.T) {
	msgs := []types.LlmMessage{{Role: "user", Content: "first"}}

	_ = AppendGitContextMessage(msgs, types.RunOptions{GitContextText: testGitContext}, "run-1", 0)

	if len(msgs) != 1 {
		t.Errorf("input slice was mutated: len = %d, want 1", len(msgs))
	}
}

// TestGitContextPrompt_DelegatedCliCarriesContext pins that the delegated-CLI
// backends still receive repository state. Those backends have no engine-owned
// message array, so they carry git context on the per-turn prompt instead —
// which is also outside the CLI's cached system prompt.
func TestGitContextPrompt_DelegatedCliCarriesContext(t *testing.T) {
	out := gitContextPrompt("do the thing", testGitContext)

	if !strings.Contains(out, testGitContext) {
		t.Error("git context missing from delegated-CLI prompt")
	}
	if !strings.HasSuffix(out, "do the thing") {
		t.Errorf("user prompt must remain the trailing content, got %q", out)
	}
}

// TestGitContextPrompt_EmptyContextUnchanged verifies a non-repo run sends the
// bare prompt with no empty reminder wrapper.
func TestGitContextPrompt_EmptyContextUnchanged(t *testing.T) {
	if out := gitContextPrompt("do the thing", ""); out != "do the thing" {
		t.Errorf("prompt = %q, want unchanged", out)
	}
	if out := gitContextPrompt("do the thing", "   "); out != "do the thing" {
		t.Errorf("whitespace-only context should be treated as absent, got %q", out)
	}
}
