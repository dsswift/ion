package backend

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestPrefixTracker_ReportsWhichPartChanged(t *testing.T) {
	tracker := newPrefixTracker()
	parts := func(model, system, toolList string) map[string]string {
		return map[string]string{"model_hash": model, "system_hash": system, "tools_hash": toolList}
	}

	if changed, first := tracker.observe("c1", parts("m", "s", "t")); !first || changed != nil {
		t.Fatalf("first run: first=%v changed=%v", first, changed)
	}
	if changed, first := tracker.observe("c1", parts("m", "s", "t")); first || len(changed) != 0 {
		t.Fatalf("identical run: first=%v changed=%v", first, changed)
	}
	changed, _ := tracker.observe("c1", parts("m", "s2", "t2"))
	if !reflect.DeepEqual(changed, []string{"system_hash", "tools_hash"}) {
		t.Fatalf("changed = %v, want [system_hash tools_hash]", changed)
	}
	// Each conversation is tracked on its own.
	if _, first := tracker.observe("c2", parts("m", "s", "t")); !first {
		t.Fatal("a second conversation must start with no previous run")
	}
}

// The values that change every run without changing the prompt must not read
// as a prefix change, or the warning would fire on every prompt.
func TestCliPrefixParts_IgnoresPerRunValues(t *testing.T) {
	base := []string{"-p", "--permission-mode", "bypassPermissions", "--model", "sonnet",
		"--append-system-prompt", "aliases", "--allowedTools", "Read,Grep",
		"--resume", "session-1", "--mcp-config", "/tmp/a.json", "--settings", "/tmp/s1.json"}
	resumed := []string{"-p", "--permission-mode", "bypassPermissions", "--model", "sonnet",
		"--append-system-prompt", "aliases", "--allowedTools", "Read,Grep",
		"--resume", "session-2", "--mcp-config", "/tmp/b.json", "--settings", "/tmp/s2.json", "--max-turns", "9"}
	if !reflect.DeepEqual(cliPrefixParts(base), cliPrefixParts(resumed)) {
		t.Fatal("a different resume id or per-session file path must not change the fingerprint")
	}

	for name, changed := range map[string][]string{
		"append-system-prompt_hash": {"-p", "--permission-mode", "bypassPermissions", "--model", "sonnet", "--append-system-prompt", "aliases plus plan prompt", "--allowedTools", "Read,Grep"},
		"model_hash":                {"-p", "--permission-mode", "bypassPermissions", "--model", "opus", "--append-system-prompt", "aliases", "--allowedTools", "Read,Grep"},
		"other_args_hash":           {"-p", "--permission-mode", "bypassPermissions", "--disallowedTools", "Write", "--model", "sonnet", "--append-system-prompt", "aliases", "--allowedTools", "Read,Grep"},
	} {
		if cliPrefixParts(base)[name] == cliPrefixParts(changed)[name] {
			t.Errorf("%s must change when that argument does", name)
		}
	}
}

// TestPromptPrefixStableAcrossAConversation is the cache contract, end to end.
//
// One conversation is driven through every plan-mode transition, each as its
// own run reloaded from disk: an auto prompt, an operator switch into plan
// mode, a second planning prompt, the implementation run, and a run in which
// the model enters plan mode itself. Every request the provider receives must
// carry the same tool list and system prompt, and its messages must extend the
// previous request's messages without altering any of them. That is exactly
// what a prefix cache needs to stay valid.
//
// Revert-check: filter the tool list by mode, put the plan prompt back in the
// system prompt, or send a plan-mode message that is not saved as sent, and
// this goes red.
func TestPromptPrefixStableAcrossAConversation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	planFile := t.TempDir() + "/plan.md"
	const convID = "1790000000000-prefixcontract"

	provider := setupToolCapturingProvider([][]types.LlmStreamEvent{
		// Run 1, auto.
		textResponse("hello", 10, 5),
		// Run 2, the operator switched to plan mode: one tool round, then done.
		toolUseResponse("Read", "tc-read", map[string]any{"file_path": "/nonexistent"}, 10, 5),
		textResponse("planned", 10, 5),
		// Run 3, still planning.
		textResponse("refined", 10, 5),
		// Run 4, the implementation run.
		textResponse("implemented", 10, 5),
		// Run 5, auto: the model enters plan mode itself.
		toolUseResponse(tools.EnterPlanModeName, "tc-enter", map[string]any{}, 10, 5),
		textResponse("planning again", 10, 5),
	})

	autoExitOff := false
	cfg := &RunConfig{Hooks: RunHooks{
		OnPlanModeEnter: func() (bool, string, string) { return true, "", planFile },
	}}
	run := func(reqID, prompt string, mutate func(*types.RunOptions)) {
		t.Helper()
		b := NewApiBackend()
		c := collectEvents(b, reqID)
		opts := types.RunOptions{
			Prompt:           prompt,
			ConversationID:   convID,
			ProjectPath:      t.TempDir(),
			Model:            testModel,
			EarlyStopEnabled: testEarlyStopDisabled(),
			PlanModeAutoExit: &autoExitOff,
			PlanFilePath:     planFile,
			SystemPrompt:     "You are a coding agent.",
		}
		if mutate != nil {
			mutate(&opts)
		}
		b.StartRunWithConfig(reqID, opts, cfg)
		if !waitForExit(c, 5*time.Second) {
			t.Fatalf("%s: timed out waiting for run to exit", reqID)
		}
	}

	run("prefix-1", "say hello", nil)
	run("prefix-2", "plan the feature", func(o *types.RunOptions) { o.PlanMode = true })
	run("prefix-3", "tighten the plan", func(o *types.RunOptions) { o.PlanMode = true })
	run("prefix-4", "Implement the plan.", func(o *types.RunOptions) { o.ImplementationPhase = true })
	run("prefix-5", "now plan the follow-up", nil)

	if got := provider.callsMade(); got != 7 {
		t.Fatalf("expected 7 provider calls, got %d", got)
	}
	assertPrefixStable(t, provider)

	// The mode changes are told to the model in order, as messages.
	final := provider.requestForCall(6)
	var notices []string
	for _, msg := range final.Messages {
		if msg.Role != "user" {
			continue
		}
		text := messageText(t, msg)
		switch {
		case strings.HasPrefix(text, "## Re-entering Plan Mode"):
			notices = append(notices, "reenter")
		case strings.HasPrefix(text, "[PLAN MODE ENDED]"):
			notices = append(notices, "exit")
		case strings.HasPrefix(text, "[PLAN MODE]"):
			notices = append(notices, "enter")
		case strings.HasPrefix(text, "[SYSTEM] Plan mode still active"):
			notices = append(notices, "reminder")
		}
	}
	if want := []string{"enter", "exit", "reenter"}; !reflect.DeepEqual(notices, want) {
		t.Fatalf("plan-mode notices = %v, want %v", notices, want)
	}
}
