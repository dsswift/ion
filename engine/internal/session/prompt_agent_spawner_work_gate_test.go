package session

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// errChildStubFailed stands in for a child run that broke, so the declined
// verdict can be proven not to overwrite a genuine failure.
var errChildStubFailed = errors.New("child blew up")

// The built-in Agent tool declares DispatchAgentOpts.RequireToolUse on the
// dispatcher's behalf, because on this path there is no harness to declare it:
// the LLM called Agent directly.
//
// This is the exact path that produced the observed production waste with NO
// extension loaded (system_prompt_len 0): a child read its task, wrote a
// paragraph promising to start ("Got it. I will do exactly this... I'll do it
// now."), called no tools, and was reported to the orchestrator as ExitCode:0
// success. The orchestrator believed it and re-dispatched — one agent eleven
// times with a byte-identical task.
//
// These tests pin the fix at the tool boundary, which is where a consumer
// actually observes it.

// A child that promises work and calls no tools must NOT read as success. The
// promise text is preserved so the caller can see what was claimed.
func TestAgentTool_PromiseWithoutToolUseIsDeclined(t *testing.T) {
	promise := "Got it. I will implement the namespace change now."
	stub := &childStubBackend{resultText: promise, noToolUse: true}

	result, _, err := runSpawnerOnce(t, stub, context.Background(), "implement the namespace change")
	if err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	// The verdict must be stated, not implied.
	if !strings.Contains(result, "No work was performed") {
		t.Errorf("a zero-tool completion must be reported as no work done, got:\n%s", result)
	}
	// The child's own words survive: the dispatcher needs them to decide
	// whether to re-dispatch with a sharper task or do the work itself.
	if !strings.Contains(result, promise) {
		t.Errorf("the child's final response must be preserved, got:\n%s", result)
	}
	// The bare promise must never be returned as though it were the outcome.
	if stripUsageSuffix(result) == promise {
		t.Error("the promise text alone must not be returned as a successful result")
	}
}

// The gate gives exactly ONE continuation. A child that starts working after
// being told to is a success, not a failure — the gate exists to get work
// done, not to punish a slow start.
func TestAgentTool_ToolUseAfterContinuationSucceeds(t *testing.T) {
	stub := &childStubBackend{resultText: "child output"}

	result, _, err := runSpawnerOnce(t, stub, context.Background(), "do thing")
	if err != nil {
		t.Fatalf("spawner returned error: %v", err)
	}

	if strings.Contains(result, "No work was performed") {
		t.Errorf("a child that called tools must not be declined, got:\n%s", result)
	}
	if stripUsageSuffix(result) != "child output" {
		t.Errorf("result = %q, want the child's output", stripUsageSuffix(result))
	}
}

// A child that fails keeps its failure. Relabelling a crash as "declined"
// would send a consumer chasing the wrong cause — the two outcomes call for
// different responses, and the gate must not overwrite a real error.
func TestAgentTool_FailedChildKeepsItsError(t *testing.T) {
	stub := &childStubBackend{childErr: errChildStubFailed, noToolUse: true}

	result, _, err := runSpawnerOnce(t, stub, context.Background(), "do thing")

	// The spawner surfaces child errors as an error or an error-shaped result;
	// either way the declined verdict must not have replaced the failure.
	combined := result
	if err != nil {
		combined += " " + err.Error()
	}
	if strings.Contains(combined, "No work was performed") {
		t.Errorf("a failed child must not be relabelled as declined, got:\n%s", combined)
	}
	if !strings.Contains(combined, "child blew up") {
		t.Errorf("the child's real error must survive, got:\n%s", combined)
	}
}
