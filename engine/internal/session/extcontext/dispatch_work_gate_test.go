package extcontext

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// The work gate exists because a dispatched child could answer its task
// instead of performing it — write a paragraph promising to start, call no
// tools, and be reported to its dispatcher as ExitCode:0 success. The
// dispatcher believed the report and re-dispatched the same task repeatedly.
//
// These tests pin the gate's decision table. Each of them fails on the
// unfixed code: before this change there was no gate to consult, no
// ExitCodeDeclined to report, and no ToolCount on the result to judge.

func boolPtr(b bool) *bool { return &b }

// A dispatcher that declared nothing gets no verdict. This is the arm that
// guarantees the gate is a mechanism and not a heuristic: a summarization
// dispatch legitimately calls zero tools, and the engine must not infer an
// expectation the caller never stated.
func TestWorkGate_NoDeclarationNeverJudges(t *testing.T) {
	gate := newWorkGateState(nil, "agent-1", "dispatch-1", "sess")

	if gate.required {
		t.Fatal("nil RequireToolUse must not enforce")
	}
	// Zero tool calls, clean exit: the exact shape that would be declined if
	// an expectation had been declared.
	if got := gate.evaluate(0, 0, false, "agent-1", "dispatch-1", "sess"); got != workGateInert {
		t.Errorf("nil declaration with zero tools = %v, want workGateInert", got)
	}
}

// Explicit false is a real answer, not an absent one: analysis dispatches opt
// out on purpose and must never be nudged.
func TestWorkGate_ExplicitExemptNeverJudges(t *testing.T) {
	gate := newWorkGateState(boolPtr(false), "agent-1", "dispatch-1", "sess")

	if gate.required {
		t.Fatal("RequireToolUse=false must not enforce")
	}
	if got := gate.evaluate(0, 0, false, "agent-1", "dispatch-1", "sess"); got != workGateInert {
		t.Errorf("explicit exempt with zero tools = %v, want workGateInert", got)
	}
}

// The core sequence: one continuation, then a verdict. Not zero (the child
// never learns it stopped early), and not two or more (that is a loop burning
// the operator's tokens).
func TestWorkGate_OneContinuationThenDeclined(t *testing.T) {
	gate := newWorkGateState(boolPtr(true), "agent-1", "dispatch-1", "sess")

	if !gate.required {
		t.Fatal("RequireToolUse=true must enforce")
	}

	first := gate.evaluate(0, 0, false, "agent-1", "dispatch-1", "sess")
	if first != workGateRetry {
		t.Fatalf("first zero-tool completion = %v, want workGateRetry", first)
	}

	// The caller arms the continuation before looping; that is what spends the
	// single retry.
	runOpts := &types.RunOptions{Prompt: "original task", ConversationID: ""}
	gate.armContinuation(runOpts, "child-conv-1", "agent-1", "dispatch-1", "sess")

	second := gate.evaluate(0, 0, false, "agent-1", "dispatch-1", "sess")
	if second != workGateDeclined {
		t.Fatalf("second zero-tool completion = %v, want workGateDeclined", second)
	}

	// Third and later evaluations must stay declined, never retry again. The
	// terminal path evaluates a second time to build the result, so a gate
	// that re-armed here would loop forever.
	if third := gate.evaluate(0, 0, false, "agent-1", "dispatch-1", "sess"); third != workGateDeclined {
		t.Errorf("third evaluation = %v, want workGateDeclined (retry must not re-arm)", third)
	}
}

// A child that takes the continuation and does the work exits cleanly. The
// gate's purpose is to get work done, not to punish a slow start.
func TestWorkGate_ToolUseAfterContinuationSatisfies(t *testing.T) {
	gate := newWorkGateState(boolPtr(true), "agent-1", "dispatch-1", "sess")

	if got := gate.evaluate(0, 0, false, "agent-1", "dispatch-1", "sess"); got != workGateRetry {
		t.Fatalf("first evaluation = %v, want workGateRetry", got)
	}
	runOpts := &types.RunOptions{}
	gate.armContinuation(runOpts, "child-conv-1", "agent-1", "dispatch-1", "sess")

	// The retry called tools.
	if got := gate.evaluate(3, 0, false, "agent-1", "dispatch-1", "sess"); got != workGateInert {
		t.Errorf("post-continuation tool use = %v, want workGateInert", got)
	}
}

// A child that works on its first attempt is never continued at all.
func TestWorkGate_ToolUseOnFirstAttemptNeverContinues(t *testing.T) {
	gate := newWorkGateState(boolPtr(true), "agent-1", "dispatch-1", "sess")

	if got := gate.evaluate(1, 0, false, "agent-1", "dispatch-1", "sess"); got != workGateInert {
		t.Errorf("first-attempt tool use = %v, want workGateInert", got)
	}
	if gate.continued {
		t.Error("a satisfied gate must not spend its retry")
	}
}

// A recalled or failed run keeps its own outcome. Overwriting a crash or a
// cancellation with "declined" would hide the real reason the dispatch ended
// and would send a consumer chasing the wrong cause.
func TestWorkGate_FailedAndRecalledRunsKeepTheirOutcome(t *testing.T) {
	cases := []struct {
		name     string
		exitCode int
		recalled bool
	}{
		{"error exit", 1, false},
		{"recalled", 0, true},
		{"recalled with error", 1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gate := newWorkGateState(boolPtr(true), "agent-1", "dispatch-1", "sess")
			got := gate.evaluate(0, tc.exitCode, tc.recalled, "agent-1", "dispatch-1", "sess")
			if got != workGateInert {
				t.Errorf("evaluate(%s) = %v, want workGateInert", tc.name, got)
			}
			if gate.continued {
				t.Error("a non-clean run must not spend the retry")
			}
		})
	}
}

// The continuation must RESUME the child's conversation, never replay the task
// from the top. A replay would re-elicit the same promise — the child would
// read its original task fresh and describe the work again.
func TestWorkGate_ContinuationResumesRatherThanReplays(t *testing.T) {
	gate := newWorkGateState(boolPtr(true), "agent-1", "dispatch-1", "sess")
	runOpts := &types.RunOptions{
		Prompt:         "original task text",
		ConversationID: "",
		BackgroundWork: &types.BackgroundWorkInfo{Kind: "stale"},
	}

	gate.armContinuation(runOpts, "child-conv-42", "agent-1", "dispatch-1", "sess")

	if runOpts.ConversationID != "child-conv-42" {
		t.Errorf("ConversationID = %q, want the child's own conversation", runOpts.ConversationID)
	}
	if runOpts.Prompt == "original task text" {
		t.Error("continuation must replace the task prompt, not replay it")
	}
	if runOpts.Prompt != workGateContinuation {
		t.Errorf("Prompt = %q, want the work-gate continuation", runOpts.Prompt)
	}
	if runOpts.BackgroundWork != nil {
		t.Error("BackgroundWork must be cleared: no child result is being delivered")
	}
	if runOpts.InjectionKind != string(types.InjectionKindSystemSteer) {
		t.Errorf("InjectionKind = %q, want system_steer", runOpts.InjectionKind)
	}
	if !gate.continued {
		t.Error("arming the continuation must spend the retry")
	}
}

// An empty child session ID must not clobber a caller-supplied conversation
// pin. The child's SessionInitEvent normally supplies it, but a child that
// died before emitting one leaves it empty.
func TestWorkGate_EmptyChildSessionLeavesConversationPinAlone(t *testing.T) {
	gate := newWorkGateState(boolPtr(true), "agent-1", "dispatch-1", "sess")
	runOpts := &types.RunOptions{ConversationID: "caller-supplied"}

	gate.armContinuation(runOpts, "", "agent-1", "dispatch-1", "sess")

	if runOpts.ConversationID != "caller-supplied" {
		t.Errorf("ConversationID = %q, want the pre-existing pin preserved", runOpts.ConversationID)
	}
}

// The continuation has to name the actual mistake. A generic "keep working"
// nudge invites another paragraph of narration, which is the failure being
// fixed.
func TestWorkGateContinuation_NamesTheFailureAndTheRemedy(t *testing.T) {
	if !strings.Contains(workGateContinuation, "without calling any tools") {
		t.Error("continuation must name the specific failure (no tool calls)")
	}
	if !strings.Contains(workGateContinuation, "Begin the work now") {
		t.Error("continuation must instruct the child to start working")
	}
	// The child must retain a way to say the task genuinely needs no tools,
	// otherwise the gate forces a pointless tool call to satisfy it.
	if !strings.Contains(workGateContinuation, "no tool calls") {
		t.Error("continuation must let the child explain a legitimate zero-tool task")
	}
}

// The engine counted the child's tool calls all along and discarded the
// number, leaving consumers to reconstruct it from their own lifecycle state.
// The field must exist on the result type and carry the count, because that
// scraping is exactly the harness workaround this change removes.
func TestDispatchAgentResult_CarriesToolCount(t *testing.T) {
	result := &extension.DispatchAgentResult{
		Name:      "dev-lead",
		ExitCode:  0,
		ToolCount: 7,
	}

	if result.ToolCount != 7 {
		t.Errorf("ToolCount = %d, want 7", result.ToolCount)
	}

	// The JSON tag has no omitempty: a zero count is the single most important
	// value this field carries (it is the signature of a child that did
	// nothing), so it must survive serialization rather than vanishing.
	zero := &extension.DispatchAgentResult{Name: "dev-lead", ToolCount: 0}
	encoded, err := json.Marshal(zero)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(encoded), `"toolCount":0`) {
		t.Errorf("zero ToolCount must serialize explicitly, got: %s", encoded)
	}
}

// RequireToolUse must be a tri-state pointer, not a bool. A plain bool cannot
// distinguish "no expectation declared" from "explicitly exempt", and
// collapsing those two would make the engine judge dispatches whose callers
// never asked it to.
func TestDispatchAgentOpts_RequireToolUseIsTriState(t *testing.T) {
	absent := extension.DispatchAgentOpts{Name: "a"}
	if absent.RequireToolUse != nil {
		t.Error("the zero value must be nil (no declaration)")
	}

	exempt := extension.DispatchAgentOpts{Name: "a", RequireToolUse: boolPtr(false)}
	if exempt.RequireToolUse == nil || *exempt.RequireToolUse {
		t.Error("explicit false must be distinguishable from absent")
	}

	// Absent must omit from the wire so existing callers send no new field.
	encoded, err := json.Marshal(absent)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if strings.Contains(string(encoded), "requireToolUse") {
		t.Errorf("an undeclared expectation must be omitted from the wire, got: %s", encoded)
	}
}

// Exit codes must be mutually distinguishable. A declined dispatch that shared
// a code with recall or failure would be indistinguishable from them, which is
// the whole confusion this code exists to remove.
func TestExitCodeDeclined_IsDistinct(t *testing.T) {
	if ExitCodeDeclined == 0 {
		t.Error("declined must not read as success")
	}
	if ExitCodeDeclined == 1 {
		t.Error("declined must not read as a failed run")
	}
	if ExitCodeDeclined == ExitCodeRecalled {
		t.Error("declined must not read as a recall")
	}
}

// The delivered status string is what an orchestrator reads. "declined" has to
// be its own value: an orchestrator retries failures but must not retry a
// child that ran correctly and produced nothing.
func TestChildResultStatus_DeclinedIsItsOwnStatus(t *testing.T) {
	cases := map[int]string{
		0:                "completed",
		ExitCodeRecalled: "recalled",
		ExitCodeDeclined: "declined",
		1:                "failed",
		99:               "failed",
	}
	for code, want := range cases {
		if got := childResultStatus(code); got != want {
			t.Errorf("childResultStatus(%d) = %q, want %q", code, got, want)
		}
	}
}

// The declined output must preserve the child's own words. The dispatcher needs
// to see what the child said it would do in order to decide whether to
// re-dispatch with a sharper task or do the work itself.
func TestDeclinedOutput_PreservesChildText(t *testing.T) {
	childText := "Got it. I will implement the namespace change now."
	out := declinedOutput("dev-lead", childText)

	if !strings.Contains(out, "dev-lead") {
		t.Error("declined output must name the agent")
	}
	if !strings.Contains(out, childText) {
		t.Error("declined output must preserve the child's final response verbatim")
	}
	if !strings.Contains(out, "No work was performed") {
		t.Error("declined output must state plainly that no work happened")
	}

	// A silent child produces a coherent message with no dangling header.
	bare := declinedOutput("dev-lead", "")
	if strings.Contains(bare, "final response was") {
		t.Error("declined output must not promise a response that does not exist")
	}
}
