package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestPlanModeReminderIsTransient pins Fix B: plan_mode_reminder must be
// injected into the provider request (conv.Messages grows) but must NOT be
// persisted to conversation entries (conv.Entries unchanged). This prevents
// stale "Plan mode still active" claims from accumulating in conversation
// history across mode transitions.
//
// Regression: before Fix B, injectSystemMessage routed all non-suppressed
// messages through AddUserMessage + conversation.Save, which appended to
// both conv.Messages and conv.Entries. In the triggering conversation
// (1783339918596-0a78dd0c12ca), this produced 19 persisted copies of the
// "Plan mode still active" reminder, which the model then re-read as ground
// truth on later turns after the mode had already changed.
//
// The two assertions verify BOTH sides of the transient contract:
//   - the provider request contains the reminder (conv.Messages grew — proof
//     the injection was not simply deleted to make the test pass)
//   - the entry tree does not contain the reminder (conv.Entries unchanged —
//     proof it is not written to .llm.jsonl / .tree.jsonl)
func TestPlanModeReminderIsTransient(t *testing.T) {
	dir := t.TempDir()
	conv := conversation.CreateConversation("test-reminder-persistence", "", "test-model")
	// Seed with a user prompt (the run's first message). CreateConversation
	// initializes conv.Entries to a non-nil empty slice, so the conversation is
	// in tree mode and AddUserMessage appends to both Messages and Entries.
	conversation.AddUserMessage(conv, "Make a plan for the feature.")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	msgsBefore := len(conv.Messages)
	entriesBefore := len(conv.Entries)

	b := NewApiBackend()
	run := &activeRun{requestID: "test-transient"}
	// SuppressSystemMessages defaults to false — this is the normal path that,
	// before Fix B, would have persisted the reminder.
	opts := types.RunOptions{PlanMode: true}

	b.injectSystemMessage(run, conv, RunHooks{}, opts, "plan_mode_reminder",
		"Plan mode still active (test)", 2, 10)

	// Provider sees it (in-memory message added for this turn's request).
	if got := len(conv.Messages); got != msgsBefore+1 {
		t.Errorf("plan_mode_reminder: conv.Messages want %d got %d — reminder not injected into the provider request", msgsBefore+1, got)
	}
	// Not persisted (entry count unchanged — never reaches .llm.jsonl / .tree.jsonl).
	if got := len(conv.Entries); got != entriesBefore {
		t.Errorf("plan_mode_reminder: conv.Entries want %d got %d — reminder must not be persisted", entriesBefore, got)
	}
}

// TestTurnLimitWarningIsPersisted confirms that other kinds (not
// plan_mode_reminder) still follow the normal persist path. If this test
// passes but TestPlanModeReminderIsTransient fails, the per-kind routing was
// removed rather than correctly added; if this test fails, the fix over-reached
// and made every kind transient.
func TestTurnLimitWarningIsPersisted(t *testing.T) {
	dir := t.TempDir()
	conv := conversation.CreateConversation("test-persist-warning", "", "test-model")
	conversation.AddUserMessage(conv, "Hello.")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	msgsBefore := len(conv.Messages)
	entriesBefore := len(conv.Entries)

	b := NewApiBackend()
	run := &activeRun{requestID: "test-persist"}
	opts := types.RunOptions{}

	b.injectSystemMessage(run, conv, RunHooks{}, opts, "turn_limit_warning",
		"Turn limit warning (test)", 5, 10)

	// Provider sees it.
	if got := len(conv.Messages); got != msgsBefore+1 {
		t.Errorf("turn_limit_warning: conv.Messages want %d got %d — warning not injected", msgsBefore+1, got)
	}
	// turn_limit_warning IS persisted (legitimate history entry).
	if got := len(conv.Entries); got != entriesBefore+1 {
		t.Errorf("turn_limit_warning: conv.Entries want %d got %d — warning must be persisted", entriesBefore+1, got)
	}
}

// TestSuppressSystemMessages_StillTransient confirms that SuppressSystemMessages
// still routes all kinds to transient (unchanged pre-Fix-B behavior). This
// guards against a regression where the per-kind branch accidentally displaces
// the suppress branch.
func TestSuppressSystemMessages_StillTransient(t *testing.T) {
	dir := t.TempDir()
	conv := conversation.CreateConversation("test-suppress", "", "test-model")
	conversation.AddUserMessage(conv, "Hello.")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	msgsBefore := len(conv.Messages)
	entriesBefore := len(conv.Entries)

	b := NewApiBackend()
	run := &activeRun{requestID: "test-suppress"}
	opts := types.RunOptions{SuppressSystemMessages: true}

	b.injectSystemMessage(run, conv, RunHooks{}, opts, "turn_limit_warning",
		"Turn limit warning (suppressed)", 5, 10)

	// Provider sees it.
	if got := len(conv.Messages); got != msgsBefore+1 {
		t.Errorf("SuppressSystemMessages: conv.Messages want %d got %d — message not injected", msgsBefore+1, got)
	}
	// SuppressSystemMessages → transient regardless of kind.
	if got := len(conv.Entries); got != entriesBefore {
		t.Errorf("SuppressSystemMessages: conv.Entries want %d got %d — must be transient", entriesBefore, got)
	}
}
