package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

const ledgerInterval = 5

func addAssistantTurns(conv *Conversation, n int) {
	for i := 0; i < n; i++ {
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "ok"}}, types.LlmUsage{})
	}
}

func TestPlanModeLedger_EnterReminderExit(t *testing.T) {
	conv := CreateConversation("ledger-basic", "", "m")
	AddUserMessage(conv, "plan it")

	told := PlanModeToldAt(conv)
	if told.Active {
		t.Fatal("a conversation with no notice must read as not told")
	}
	if got := ReconcilePlanMode(told, false, "", ledgerInterval); got != types.InjectionKindNone {
		t.Fatalf("auto run, never told: want no notice, got %q", got)
	}
	if got := ReconcilePlanMode(told, true, "/p/a.md", ledgerInterval); got != types.InjectionKindPlanModeEnter {
		t.Fatalf("planning, never told: want enter, got %q", got)
	}

	AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "enter", "/p/a.md", false)
	told = PlanModeToldAt(conv)
	if !told.Active || told.PlanFilePath != "/p/a.md" {
		t.Fatalf("after enter: got %+v", told)
	}
	if got := ReconcilePlanMode(told, true, "/p/a.md", ledgerInterval); got != types.InjectionKindNone {
		t.Fatalf("planning, just told: want no notice, got %q", got)
	}

	addAssistantTurns(conv, ledgerInterval-1)
	if got := ReconcilePlanMode(PlanModeToldAt(conv), true, "/p/a.md", ledgerInterval); got != types.InjectionKindNone {
		t.Fatalf("one turn short of the interval: want no notice, got %q", got)
	}
	addAssistantTurns(conv, 1)
	if got := ReconcilePlanMode(PlanModeToldAt(conv), true, "/p/a.md", ledgerInterval); got != types.InjectionKindPlanModeReminder {
		t.Fatalf("interval reached: want reminder, got %q", got)
	}
	AddPlanModeNotice(conv, types.InjectionKindPlanModeReminder, "still", "/p/a.md", false)
	if got := ReconcilePlanMode(PlanModeToldAt(conv), true, "/p/a.md", ledgerInterval); got != types.InjectionKindNone {
		t.Fatalf("just reminded: want no notice, got %q", got)
	}

	if got := ReconcilePlanMode(PlanModeToldAt(conv), false, "/p/a.md", ledgerInterval); got != types.InjectionKindPlanModeExit {
		t.Fatalf("left plan mode: want exit, got %q", got)
	}
	AddPlanModeNotice(conv, types.InjectionKindPlanModeExit, "ended", "/p/a.md", false)
	told = PlanModeToldAt(conv)
	if told.Active {
		t.Fatal("after exit the model must read as not planning")
	}
	if !told.HasExited("/p/a.md") || told.HasExited("/p/other.md") {
		t.Fatalf("HasExited must be true for the exited plan file only")
	}
	if got := ReconcilePlanMode(told, true, "/p/a.md", ledgerInterval); got != types.InjectionKindPlanModeEnter {
		t.Fatalf("back into plan mode: want enter, got %q", got)
	}
}

func TestPlanModeLedger_NewPlanFileReenters(t *testing.T) {
	conv := CreateConversation("ledger-newfile", "", "m")
	AddUserMessage(conv, "plan it")
	AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "enter", "/p/a.md", false)
	if got := ReconcilePlanMode(PlanModeToldAt(conv), true, "/p/b.md", ledgerInterval); got != types.InjectionKindPlanModeEnter {
		t.Fatalf("a different plan file: want enter, got %q", got)
	}
}

// A rewind moves the leaf. What the model was told is read from the path it
// can now see, so a notice on the abandoned branch no longer counts.
func TestPlanModeLedger_RewindForgetsNoticesOffThePath(t *testing.T) {
	conv := CreateConversation("ledger-rewind", "", "m")
	AddUserMessage(conv, "first")
	addAssistantTurns(conv, 1)
	second := AddUserMessage(conv, "now plan")
	AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "enter", "/p/a.md", false)
	addAssistantTurns(conv, 1)

	if !PlanModeToldAt(conv).Active {
		t.Fatal("precondition: told before the rewind")
	}
	if _, err := BranchBefore(conv, second.ID); err != nil {
		t.Fatalf("BranchBefore: %v", err)
	}
	told := PlanModeToldAt(conv)
	if told.Active {
		t.Fatal("after rewinding to before the enter notice, the model has not been told")
	}
	if got := ReconcilePlanMode(told, false, "", ledgerInterval); got != types.InjectionKindNone {
		t.Fatalf("rewound into auto mode: want no exit notice, got %q", got)
	}
}

// A compaction or a clear drops the earlier messages from context, including
// the instructions, so the model must be told again.
func TestPlanModeLedger_BoundaryResets(t *testing.T) {
	for _, boundary := range []SessionEntryType{EntryCompaction, EntryCleared} {
		conv := CreateConversation("ledger-boundary", "", "m")
		AddUserMessage(conv, "plan it")
		AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "enter", "/p/a.md", false)
		var data any
		if boundary == EntryCompaction {
			data = CompactionData{Summary: "s"}
		}
		AppendEntry(conv, boundary, data)
		if PlanModeToldAt(conv).Active {
			t.Errorf("%s: the model no longer sees the notice and must read as not told", boundary)
		}
	}
}

func TestPlanModeNoticeIsMachineAuthoredAndNotAPrompt(t *testing.T) {
	conv := CreateConversation("ledger-count", "", "m")
	AddUserMessage(conv, "plan it")
	before := CountUserPrompts(conv)
	entry := AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "enter", "/p/a.md", false)
	md, ok := entry.Data.(MessageData)
	if !ok {
		t.Fatalf("entry data is %T", entry.Data)
	}
	if !md.MachineAuthored || md.InjectionKind != "plan_mode_enter" || md.NoticePlanFile != "/p/a.md" {
		t.Fatalf("notice entry misclassified: %+v", md)
	}
	if got := CountUserPrompts(conv); got != before {
		t.Fatalf("a plan-mode notice counted as a user prompt: %d -> %d", before, got)
	}
}

func TestPlanModeNoticeTransientStaysOutOfTheTree(t *testing.T) {
	conv := CreateConversation("ledger-transient", "", "m")
	AddUserMessage(conv, "plan it")
	entries := len(conv.Entries)
	if AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "enter", "/p/a.md", true) != nil {
		t.Fatal("a transient notice must not return a tree entry")
	}
	if len(conv.Entries) != entries {
		t.Fatal("a transient notice was written to the tree")
	}
	if PlanModeToldAt(conv).Active {
		t.Fatal("a transient notice must not be readable from the tree")
	}
}

// The notice reloads from disk exactly as it was sent, with its place in the
// message order unchanged.
func TestPlanModeNoticeSurvivesReload(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("ledger-reload", "", "m")
	AddUserMessage(conv, "plan it")
	AddPlanModeNotice(conv, types.InjectionKindPlanModeEnter, "PLAN NOTICE BODY", "/p/a.md", false)
	addAssistantTurns(conv, 1)
	if err := Save(conv, dir); err != nil {
		t.Fatalf("save: %v", err)
	}
	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(loaded.Messages) != len(conv.Messages) {
		t.Fatalf("reloaded %d messages, sent %d", len(loaded.Messages), len(conv.Messages))
	}
	blocks := contentToBlocks(loaded.Messages[1].Content)
	if len(blocks) != 1 || blocks[0].Text != "PLAN NOTICE BODY" || loaded.Messages[1].Role != "user" {
		t.Fatalf("notice did not reload verbatim in place: %+v", loaded.Messages[1])
	}
	told := PlanModeToldAt(loaded)
	if !told.Active || told.PlanFilePath != "/p/a.md" || told.TurnsSince != 1 {
		t.Fatalf("ledger after reload: %+v", told)
	}
}
