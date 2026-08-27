package session

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestPollChildPromptRequiresEvidencedJSON(t *testing.T) {
	prompt := pollChildPrompt("wait for checks", "gh pr checks 42", "checks are running")
	for _, required := range []string{"ONLY JSON", "evidence", "satisfied, failed, advancing, stuck", "gh pr checks 42", "checks are running", "observation only", "do not modify"} {
		if !strings.Contains(prompt, required) {
			t.Errorf("prompt missing %q: %s", required, prompt)
		}
	}
}

func TestPollConfigResolvedClampsHaveDefaults(t *testing.T) {
	cfg := types.PollDefaults()
	if cfg.MinIntervalMs <= 0 || cfg.MaxDeadlineMs <= 0 || cfg.MaxAttempts <= 0 || cfg.MaxActivePerSession <= 0 {
		t.Fatalf("PollDefaults = %#v", cfg)
	}
}

func TestPollVerdictValidation(t *testing.T) {
	for _, verdict := range []types.PollVerdict{types.PollVerdictSatisfied, types.PollVerdictFailed, types.PollVerdictAdvancing, types.PollVerdictStuck} {
		if !validPollVerdict(verdict) {
			t.Errorf("validPollVerdict(%q) = false", verdict)
		}
	}
	if validPollVerdict(types.PollVerdictExhausted) {
		t.Error("exhausted must be engine-generated, not child-provided")
	}
}

func TestRunPollCheckCommandReturnsRawOutput(t *testing.T) {
	previous := tools.GetBashOperations()
	t.Cleanup(func() { tools.SetBashOperations(previous) })
	tools.SetBashOperations(&pollBashOps{result: &tools.ExecResult{Stdout: "raw status"}})
	evidence, reason := runPollCheckCommand("status", t.TempDir(), time.Minute)
	if reason != "" || evidence != "raw status" {
		t.Fatalf("runPollCheckCommand = (%q, %q)", evidence, reason)
	}
}

func TestRunPollCheckCommandHandsNonZeroResultToJudge(t *testing.T) {
	previous := tools.GetBashOperations()
	t.Cleanup(func() { tools.SetBashOperations(previous) })
	tools.SetBashOperations(&pollBashOps{result: &tools.ExecResult{ExitCode: 1, Stderr: "checks are still running"}})
	evidence, reason := runPollCheckCommand("status", t.TempDir(), time.Minute)
	if reason != "" || !strings.Contains(evidence, "exit code: 1") || !strings.Contains(evidence, "still running") {
		t.Fatalf("runPollCheckCommand = (%q, %q)", evidence, reason)
	}
}

type pollBashOps struct{ result *tools.ExecResult }

func (p *pollBashOps) Exec(context.Context, string, string, tools.ExecOptions) (*tools.ExecResult, error) {
	return p.result, nil
}
