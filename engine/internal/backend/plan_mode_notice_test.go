package backend

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// noticeConv returns a saved conversation holding one user prompt, so the
// reconciler's save lands in the test's own directory.
func noticeConv(t *testing.T, id string) *conversation.Conversation {
	t.Helper()
	conv := conversation.CreateConversation(id, "", "test-model")
	conversation.AddUserMessage(conv, "Make a plan.")
	if err := conversation.Save(conv, t.TempDir()); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	return conv
}

func lastText(t *testing.T, conv *conversation.Conversation) string {
	t.Helper()
	blocks, ok := conv.Messages[len(conv.Messages)-1].Content.([]types.LlmContentBlock)
	if !ok || len(blocks) == 0 {
		t.Fatalf("last message has no text blocks: %+v", conv.Messages[len(conv.Messages)-1])
	}
	return blocks[0].Text
}

func lastKind(t *testing.T, conv *conversation.Conversation) string {
	t.Helper()
	md, ok := conv.Entries[len(conv.Entries)-1].Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("last entry is %T", conv.Entries[len(conv.Entries)-1].Data)
	}
	return md.InjectionKind
}

func addAssistant(conv *conversation.Conversation, n int) {
	for i := 0; i < n; i++ {
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "ok"}}, types.LlmUsage{})
	}
}

// Toggle plan mode on, off, and on again across three runs. The conversation
// records enter, exit, and a re-entry enter, in order, each saved as sent.
func TestReconcilePlanMode_EnterExitReentryTimeline(t *testing.T) {
	b := NewApiBackend()
	conv := noticeConv(t, "notice-timeline")
	planFile := t.TempDir() + "/plan.md"

	planRun := &activeRun{requestID: "r1", planMode: true, planFilePath: planFile}
	opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile}
	b.reconcilePlanMode(planRun, conv, RunHooks{}, &opts, 1, 0)
	if got := lastKind(t, conv); got != "plan_mode_enter" {
		t.Fatalf("first plan run: want plan_mode_enter, got %q", got)
	}
	enter := lastText(t, conv)
	if !strings.Contains(enter, "[PLAN MODE]") || !strings.Contains(enter, planFile) {
		t.Fatalf("enter notice must carry the instructions and the plan file, got %q", enter)
	}
	if strings.Contains(enter, "Re-entering Plan Mode") {
		t.Fatal("a first entry must not carry the re-entry guidance")
	}
	if strings.Contains(enter, "elsewhere in this prompt or conversation") {
		t.Fatal("a notice must not claim to out-rank the rest of the conversation: a later exit notice has to be able to end it")
	}

	before := len(conv.Messages)
	b.reconcilePlanMode(planRun, conv, RunHooks{}, &opts, 2, 0)
	if len(conv.Messages) != before {
		t.Fatal("a second reconcile in the same mode must append nothing")
	}

	addAssistant(conv, 1)
	autoRun := &activeRun{requestID: "r2", planFilePath: planFile}
	autoOpts := types.RunOptions{PlanFilePath: planFile, ImplementationPhase: true}
	b.reconcilePlanMode(autoRun, conv, RunHooks{}, &autoOpts, 1, 0)
	if got := lastKind(t, conv); got != "plan_mode_exit" {
		t.Fatalf("auto run after planning: want plan_mode_exit, got %q", got)
	}
	if exit := lastText(t, conv); !strings.Contains(exit, "Plan mode has ended") || !strings.Contains(exit, planFile) {
		t.Fatalf("exit notice: got %q", exit)
	}

	addAssistant(conv, 1)
	replanRun := &activeRun{requestID: "r3", planMode: true, planFilePath: planFile}
	b.reconcilePlanMode(replanRun, conv, RunHooks{}, &opts, 1, 0)
	if got := lastKind(t, conv); got != "plan_mode_enter" {
		t.Fatalf("back in plan mode: want plan_mode_enter, got %q", got)
	}
	if reentry := lastText(t, conv); !strings.Contains(reentry, "Re-entering Plan Mode") {
		t.Fatalf("returning to an exited plan must carry the re-entry guidance, got %q", reentry)
	}
}

// A run that was never in plan mode owes the model nothing.
func TestReconcilePlanMode_AutoRunWithNoHistoryAppendsNothing(t *testing.T) {
	b := NewApiBackend()
	conv := noticeConv(t, "notice-auto")
	before := len(conv.Messages)
	opts := types.RunOptions{}
	b.reconcilePlanMode(&activeRun{requestID: "r"}, conv, RunHooks{}, &opts, 1, 0)
	if len(conv.Messages) != before {
		t.Fatalf("auto run with no plan history appended a notice: %q", lastText(t, conv))
	}
}

func TestReconcilePlanMode_ReminderCadenceAndDisable(t *testing.T) {
	b := NewApiBackend()
	planFile := t.TempDir() + "/plan.md"
	opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile}

	conv := noticeConv(t, "notice-reminder")
	run := &activeRun{requestID: "r", planMode: true, planFilePath: planFile}
	b.reconcilePlanMode(run, conv, RunHooks{}, &opts, 1, 0)
	addAssistant(conv, planModeReminderInterval-1)
	before := len(conv.Messages)
	b.reconcilePlanMode(run, conv, RunHooks{}, &opts, 2, 0)
	if len(conv.Messages) != before {
		t.Fatal("reminder sent before the interval elapsed")
	}
	addAssistant(conv, 1)
	b.reconcilePlanMode(run, conv, RunHooks{}, &opts, 3, 0)
	if got := lastKind(t, conv); got != "plan_mode_reminder" {
		t.Fatalf("interval elapsed: want plan_mode_reminder, got %q", got)
	}
	if text := lastText(t, conv); !strings.HasPrefix(text, "[SYSTEM] Plan mode still active") {
		t.Fatalf("reminder text: got %q", text)
	}

	disabled := noticeConv(t, "notice-reminder-off")
	offOpts := types.RunOptions{PlanMode: true, PlanFilePath: planFile, DisablePlanModeReminder: true}
	offRun := &activeRun{requestID: "r-off", planMode: true, planFilePath: planFile}
	b.reconcilePlanMode(offRun, disabled, RunHooks{}, &offOpts, 1, 0)
	addAssistant(disabled, planModeReminderInterval)
	before = len(disabled.Messages)
	b.reconcilePlanMode(offRun, disabled, RunHooks{}, &offOpts, 2, 0)
	if len(disabled.Messages) != before {
		t.Fatal("DisablePlanModeReminder must stop the reminder")
	}
}

// The harness keeps control of the words: RunOptions.PlanModePrompt and the
// plan_mode_prompt hook supply the enter text, and system_inject can rewrite
// or withhold any notice.
func TestReconcilePlanMode_HarnessSeams(t *testing.T) {
	b := NewApiBackend()
	planFile := t.TempDir() + "/plan.md"

	t.Run("run options prompt", func(t *testing.T) {
		conv := noticeConv(t, "notice-opts")
		opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile, PlanModePrompt: "HARNESS PROMPT"}
		hookCalled := false
		hooks := RunHooks{OnPlanModePrompt: func(string) (string, []string, string) {
			hookCalled = true
			return "HOOK PROMPT", nil, ""
		}}
		b.reconcilePlanMode(&activeRun{requestID: "r", planMode: true, planFilePath: planFile}, conv, hooks, &opts, 1, 0)
		if got := lastText(t, conv); got != "HARNESS PROMPT" {
			t.Fatalf("want the RunOptions prompt verbatim, got %q", got)
		}
		if hookCalled {
			t.Fatal("the plan_mode_prompt hook must not be consulted when RunOptions supplies the prompt")
		}
	})

	t.Run("hook prompt and tools", func(t *testing.T) {
		conv := noticeConv(t, "notice-hook")
		opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile}
		calls := 0
		hooks := RunHooks{OnPlanModePrompt: func(path string) (string, []string, string) {
			calls++
			if path != planFile {
				t.Errorf("hook plan file: want %q got %q", planFile, path)
			}
			return "HOOK PROMPT", []string{"Read"}, "HOOK REMINDER"
		}}
		run := &activeRun{requestID: "r", planMode: true, planFilePath: planFile}
		b.reconcilePlanMode(run, conv, hooks, &opts, 1, 0)
		b.reconcilePlanMode(run, conv, hooks, &opts, 2, 0)
		if calls != 1 {
			t.Fatalf("plan_mode_prompt hook fired %d times in one run, want 1", calls)
		}
		if got := lastText(t, conv); got != "HOOK PROMPT" {
			t.Fatalf("want the hook prompt verbatim, got %q", got)
		}
		if len(run.planModeTools) != 1 || run.planModeTools[0] != "Read" {
			t.Fatalf("hook tool list must reach the plan policy, got %v", run.planModeTools)
		}
		if run.planPolicy("").Decide("Grep", nil).Verdict != planDeny {
			t.Fatal("a tool outside the harness list must be refused")
		}
	})

	t.Run("system_inject rewrites", func(t *testing.T) {
		conv := noticeConv(t, "notice-rewrite")
		opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile}
		var seenKind string
		hooks := RunHooks{OnSystemInject: func(kind, _ string, _, _ int) (string, bool) {
			seenKind = kind
			return "REWRITTEN", false
		}}
		b.reconcilePlanMode(&activeRun{requestID: "r", planMode: true, planFilePath: planFile}, conv, hooks, &opts, 1, 0)
		if seenKind != "plan_mode_enter" || lastText(t, conv) != "REWRITTEN" {
			t.Fatalf("system_inject rewrite: kind %q text %q", seenKind, lastText(t, conv))
		}
	})

	t.Run("system_inject suppresses once", func(t *testing.T) {
		conv := noticeConv(t, "notice-suppress")
		opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile}
		calls := 0
		hooks := RunHooks{OnSystemInject: func(string, string, int, int) (string, bool) {
			calls++
			return "", true
		}}
		run := &activeRun{requestID: "r", planMode: true, planFilePath: planFile}
		before := len(conv.Messages)
		b.reconcilePlanMode(run, conv, hooks, &opts, 1, 0)
		b.reconcilePlanMode(run, conv, hooks, &opts, 2, 0)
		if len(conv.Messages) != before {
			t.Fatal("a suppressed notice was appended")
		}
		if calls != 1 {
			t.Fatalf("a suppressed notice must not be offered again every turn; hook fired %d times", calls)
		}
	})
}

// SuppressSystemMessages keeps the notice out of the tree. The model still
// gets it, once.
func TestReconcilePlanMode_SuppressSystemMessagesIsTransient(t *testing.T) {
	b := NewApiBackend()
	conv := noticeConv(t, "notice-transient")
	planFile := t.TempDir() + "/plan.md"
	opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile, SuppressSystemMessages: true}
	run := &activeRun{requestID: "r", planMode: true, planFilePath: planFile}
	msgs, entries := len(conv.Messages), len(conv.Entries)
	b.reconcilePlanMode(run, conv, RunHooks{}, &opts, 1, 0)
	b.reconcilePlanMode(run, conv, RunHooks{}, &opts, 2, 0)
	if len(conv.Messages) != msgs+1 {
		t.Fatalf("want exactly one transient notice, messages %d -> %d", msgs, len(conv.Messages))
	}
	if len(conv.Entries) != entries {
		t.Fatal("a transient notice was written to the tree")
	}
}

// What the model was sent is what a later run reloads: the provider's cache
// for this conversation stays valid across the run boundary.
func TestReconcilePlanMode_ReloadReproducesSentMessages(t *testing.T) {
	b := NewApiBackend()
	conv := noticeConv(t, "notice-reload")
	planFile := t.TempDir() + "/plan.md"
	opts := types.RunOptions{PlanMode: true, PlanFilePath: planFile}
	b.reconcilePlanMode(&activeRun{requestID: "r", planMode: true, planFilePath: planFile}, conv, RunHooks{}, &opts, 1, 0)
	addAssistant(conv, 1)
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := conversation.Load(conv.ID, "")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Messages) != len(conv.Messages) {
		t.Fatalf("reloaded %d messages, sent %d", len(loaded.Messages), len(conv.Messages))
	}
	// Compare as decoded JSON: a reloaded message holds generic maps where the
	// live one holds typed blocks, and only the content matters.
	canonical := func(v any) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var generic any
		if err := json.Unmarshal(raw, &generic); err != nil {
			t.Fatal(err)
		}
		out, err := json.Marshal(generic)
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	for i := range conv.Messages {
		sent, got := canonical(conv.Messages[i].Content), canonical(loaded.Messages[i].Content)
		if conv.Messages[i].Role != loaded.Messages[i].Role || sent != got {
			t.Fatalf("message %d differs after reload:\nsent %s\ngot  %s", i, sent, got)
		}
	}
}

// The EnterPlanMode tool result is the one durable fact. The instructions
// arrive as the notice that follows, so nothing in the result expires.
func TestEnterPlanModeResultIsTheDurableFact(t *testing.T) {
	planFile := t.TempDir() + "/plan.md"
	run := &activeRun{requestID: "enter"}
	results := make([]conversation.ToolResultEntry, 1)
	block := types.LlmContentBlock{Type: "tool_use", ID: "tool-1", Name: tools.EnterPlanModeName}
	hooks := RunHooks{OnPlanModeEnter: func() (bool, string, string) { return true, "", planFile }}

	if !interceptEnterPlanMode(run, block, results, 0, hooks, func(*activeRun, types.NormalizedEvent) {}) {
		t.Fatal("interceptEnterPlanMode: want handled")
	}
	got := results[0].Content
	if !strings.Contains(got, planFile) {
		t.Errorf("result must name the plan file, got %q", got)
	}
	if strings.Contains(got, "[PLAN MODE]") || strings.Contains(got, "MUST NOT") {
		t.Errorf("result must not carry the plan-mode instructions, got %q", got)
	}
	if !run.planMode || run.planFilePath != planFile {
		t.Errorf("run must be planning against %q after entry", planFile)
	}

	// The next turn's reconcile supplies the instructions.
	b := NewApiBackend()
	conv := noticeConv(t, "enter-then-notice")
	opts := types.RunOptions{}
	b.reconcilePlanMode(run, conv, RunHooks{}, &opts, 2, 0)
	if lastKind(t, conv) != "plan_mode_enter" || !strings.Contains(lastText(t, conv), "[PLAN MODE]") {
		t.Fatalf("the turn after EnterPlanMode must carry the enter notice, got %q", lastText(t, conv))
	}
}
