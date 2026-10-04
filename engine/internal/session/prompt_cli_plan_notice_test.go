package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// noticeSession registers a claude-code session whose conversation is on disk
// with one user turn, as it is once a prompt has been dispatched.
func noticeSession(t *testing.T, key string) (*Manager, *engineSession) {
	t.Helper()
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession(key)
	s.conversationID = "conv-" + key
	mgr.mu.Lock()
	mgr.sessions[key] = s
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(s.conversationID, "", "m")
	conversation.AddUserMessage(conv, "first prompt")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	return mgr, s
}

func setPlan(mgr *Manager, s *engineSession, planning bool, planFile string) {
	mgr.mu.Lock()
	s.planMode = planning
	s.planFilePath = planFile
	mgr.mu.Unlock()
}

func toldOnDisk(t *testing.T, s *engineSession) conversation.PlanModeTold {
	t.Helper()
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return conversation.PlanModeToldAt(conv)
}

// dispatch runs the notice step for one prompt on a resumed CLI session.
func dispatch(mgr *Manager, s *engineSession, key, prompt string, resuming bool) string {
	opts := types.RunOptions{Prompt: prompt}
	if resuming {
		opts.CliResumeSessionID = "cli-session"
	}
	mgr.deliverCliPlanNotice(s, key, nil, false, &opts, prompt)
	return opts.Prompt
}

// The full cycle on a resumed claude-code session: enter when the session
// starts planning, nothing while it keeps planning, exit when it stops.
func TestDeliverCliPlanNotice_EnterThenExit(t *testing.T) {
	const key = "notice-cycle"
	mgr, s := noticeSession(t, key)
	planFile := t.TempDir() + "/plan.md"

	if got := dispatch(mgr, s, key, "hello", true); got != "hello" {
		t.Fatalf("auto session with no plan history: prompt was changed to %q", got)
	}

	setPlan(mgr, s, true, planFile)
	entered := dispatch(mgr, s, key, "plan this", true)
	if !strings.HasPrefix(entered, "<system-reminder>\n[PLAN MODE]") || !strings.HasSuffix(entered, "</system-reminder>\n\nplan this") {
		t.Fatalf("enter notice must lead the user turn, got %q", entered)
	}
	if !strings.Contains(entered, planFile) {
		t.Errorf("enter notice must name the plan file")
	}
	if told := toldOnDisk(t, s); !told.Active || told.PlanFilePath != planFile {
		t.Fatalf("the conversation must record the enter notice, got %+v", told)
	}

	if got := dispatch(mgr, s, key, "keep going", true); got != "keep going" {
		t.Fatalf("still planning and already told: prompt was changed to %q", got)
	}

	setPlan(mgr, s, false, planFile)
	exited := dispatch(mgr, s, key, "implement it", true)
	if !strings.Contains(exited, "Plan mode has ended") || !strings.HasSuffix(exited, "\n\nimplement it") {
		t.Fatalf("exit notice must lead the user turn, got %q", exited)
	}
	if told := toldOnDisk(t, s); told.Active || !told.HasExited(planFile) {
		t.Fatalf("the conversation must record the exit notice, got %+v", told)
	}

	if got := dispatch(mgr, s, key, "next", true); got != "next" {
		t.Fatalf("auto session already told plan mode ended: prompt was changed to %q", got)
	}
}

// A bridged run starts a fresh CLI session that holds none of the earlier
// instructions, so a planning session is told again whatever the record says.
func TestDeliverCliPlanNotice_BridgedPlanningRunIsToldAgain(t *testing.T) {
	const key = "notice-bridge"
	mgr, s := noticeSession(t, key)
	planFile := t.TempDir() + "/plan.md"
	setPlan(mgr, s, true, planFile)
	dispatch(mgr, s, key, "plan this", true)
	if !toldOnDisk(t, s).Active {
		t.Fatal("precondition: the model was told")
	}

	const seed = "<prior-conversation>\n...\n</prior-conversation>\n\n"
	opts := types.RunOptions{Prompt: seed + "continue"}
	mgr.deliverCliPlanNotice(s, key, nil, false, &opts, "continue")

	if !strings.HasPrefix(opts.Prompt, seed+"<system-reminder>\n[PLAN MODE]") {
		t.Fatalf("the notice must sit between the transcript seed and the user turn, got %q", opts.Prompt)
	}
	if !strings.HasSuffix(opts.Prompt, "</system-reminder>\n\ncontinue") {
		t.Fatalf("the user turn must follow the notice, got %q", opts.Prompt)
	}
}

// With no conversation on disk yet the notice is still sent, and is held so
// the turn write records it.
func TestDeliverCliPlanNotice_HeldUntilTheConversationExists(t *testing.T) {
	const key = "notice-held"
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := newCliSession(key)
	mgr.mu.Lock()
	mgr.sessions[key] = s
	mgr.mu.Unlock()
	setPlan(mgr, s, true, "/plans/a.md")

	got := dispatch(mgr, s, key, "plan this", false)
	if !strings.Contains(got, "[PLAN MODE]") {
		t.Fatalf("the model must be told even before the conversation exists, got %q", got)
	}
	mgr.mu.Lock()
	held := s.pendingCliPlanNotice
	mgr.mu.Unlock()
	if held == nil || held.kind != types.InjectionKindPlanModeEnter || held.planFilePath != "/plans/a.md" {
		t.Fatalf("the notice must be held for the turn write, got %+v", held)
	}
}

// The harness keeps control of the words on the CLI path too.
func TestDeliverCliPlanNotice_HarnessPromptAndSuppression(t *testing.T) {
	const key = "notice-harness"
	mgr, s := noticeSession(t, key)
	setPlan(mgr, s, true, "/plans/a.md")

	opts := types.RunOptions{Prompt: "plan", CliResumeSessionID: "cli", PlanModePrompt: "HARNESS PLAN PROMPT"}
	mgr.deliverCliPlanNotice(s, key, nil, false, &opts, "plan")
	if opts.Prompt != "<system-reminder>\nHARNESS PLAN PROMPT\n</system-reminder>\n\nplan" {
		t.Fatalf("want the harness prompt verbatim, got %q", opts.Prompt)
	}

	const transientKey = "notice-transient"
	mgr2, s2 := noticeSession(t, transientKey)
	setPlan(mgr2, s2, true, "/plans/a.md")
	first := types.RunOptions{Prompt: "plan", CliResumeSessionID: "cli", SuppressSystemMessages: true}
	mgr2.deliverCliPlanNotice(s2, transientKey, nil, false, &first, "plan")
	if !strings.Contains(first.Prompt, "[PLAN MODE]") {
		t.Fatal("SuppressSystemMessages must still tell the model")
	}
	if toldOnDisk(t, s2).Active {
		t.Fatal("SuppressSystemMessages must keep the notice out of the conversation")
	}
	second := types.RunOptions{Prompt: "more", CliResumeSessionID: "cli", SuppressSystemMessages: true}
	mgr2.deliverCliPlanNotice(s2, transientKey, nil, false, &second, "more")
	if second.Prompt != "more" {
		t.Fatalf("an unrecorded notice must not be sent again on the next prompt, got %q", second.Prompt)
	}
}

// The API backend delivers its notices inside its own run loop.
func TestDeliverCliPlanNotice_NoopForApiBackend(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	s := newCliSession("notice-api")
	setPlan(mgr, s, true, "/plans/a.md")
	opts := types.RunOptions{Prompt: "plan"}
	mgr.deliverCliPlanNotice(s, "notice-api", nil, false, &opts, "plan")
	if opts.Prompt != "plan" {
		t.Fatalf("api backend prompt was changed to %q", opts.Prompt)
	}
}

// A model that enters plan mode itself is told by the tool result, and the
// conversation records that, so a later exit has something to end.
func TestEnterPlanModeToolHandler_RecordsTheEnterNotice(t *testing.T) {
	const key = "notice-enter-tool"
	mgr, s := noticeSession(t, key)

	res, err := enterPlanModeToolHandler(mgr, key)(context.Background(), map[string]interface{}{})
	if err != nil || res.IsError {
		t.Fatalf("EnterPlanMode: res=%+v err=%v", res, err)
	}
	if !strings.Contains(res.Content, "Plan mode is now active") {
		t.Fatalf("result must tell the model plan mode is active, got %q", res.Content)
	}
	told := toldOnDisk(t, s)
	if !told.Active || told.PlanFilePath == "" {
		t.Fatalf("the conversation must record the entry, got %+v", told)
	}

	setPlan(mgr, s, false, told.PlanFilePath)
	if got := dispatch(mgr, s, key, "implement it", true); !strings.Contains(got, "Plan mode has ended") {
		t.Fatalf("a plan the model entered itself must be ended by an exit notice, got %q", got)
	}
}

// The plan tools are registered on an implementation run, so the refusal the
// flag promises happens when EnterPlanMode is called.
func TestEnterPlanModeToolHandler_RefusedOnImplementationRun(t *testing.T) {
	const key = "notice-impl"
	mgr, s := noticeSession(t, key)
	opts := types.RunOptions{ImplementationPhase: true}
	mgr.wirePlanToolServer(s, key, &opts)
	mgr.mu.Lock()
	ts := s.toolServer
	mgr.mu.Unlock()
	defer ts.Stop()

	res, ok, err := ts.InvokeTool(context.Background(), "EnterPlanMode", map[string]interface{}{})
	if err != nil || !ok {
		t.Fatalf("InvokeTool: ok=%v err=%v", ok, err)
	}
	if !strings.Contains(res.Content, "already approved") {
		t.Fatalf("want a refusal that says why, got %q", res.Content)
	}
	if planning, _ := mgr.GetPlanModeState(key); planning {
		t.Fatal("an implementation run must not enter plan mode")
	}
}

// ExitPlanMode is registered in every mode. Outside plan mode it has no plan
// to present and says so.
func TestPlanModeExitToolHandler_NotPlanning(t *testing.T) {
	const key = "notice-exit-tool"
	mgr, s := noticeSession(t, key)
	handler := planModeExitToolHandler(mgr, key)

	res, err := handler(context.Background(), map[string]interface{}{})
	if err != nil || !strings.Contains(res.Content, "Plan mode is not active") {
		t.Fatalf("not planning: res=%+v err=%v", res, err)
	}

	setPlan(mgr, s, true, "/plans/a.md")
	res, err = handler(context.Background(), map[string]interface{}{})
	if err != nil || !strings.Contains(res.Content, "Plan presented for approval") {
		t.Fatalf("planning: res=%+v err=%v", res, err)
	}
}

// A notice held at dispatch (no conversation on disk yet) is written with the
// turn, so the first prompt of a conversation still leaves a record.
func TestPersistCliTurn_WritesTheHeldPlanNotice(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID = "notice-first-turn", "1784000000020-bbbbbbbbbbbb"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.pendingCliUserTurn = "plan the feature"
	s.pendingCliAssistantText = "Here is the plan."
	s.pendingCliPlanNotice = &cliPlanNotice{kind: types.InjectionKindPlanModeEnter, text: "ENTER NOTICE", planFilePath: "/plans/a.md"}
	mgr.mu.Unlock()

	mgr.persistCliTurn(key, convID)

	told := toldOnDisk(t, s)
	if !told.Active || told.PlanFilePath != "/plans/a.md" {
		t.Fatalf("the held notice was not written with the turn: %+v", told)
	}
	mgr.mu.Lock()
	held := s.pendingCliPlanNotice
	mgr.mu.Unlock()
	if held != nil {
		t.Fatal("the held notice must be cleared once written")
	}
}
