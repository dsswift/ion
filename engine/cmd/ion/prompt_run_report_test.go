package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// closingStatus is the status the engine sends when it closes a run.
const closingStatus = `{"type":"engine_status","fields":{"state":"idle","model":"","runCostUsd":0.42,"numTurns":3,"completionReason":"completed","runUsage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":5000,"cacheCreationTokens":300,"durationMs":4200}}}`

// runReportOf runs `ion prompt --attach` against a fake engine that streams
// events, and returns its exit code and the run report on its last line.
func runReportOf(t *testing.T, events []string) (int, *runReport, string) {
	t.Helper()
	addr := serveStreamEvents(t, nil, events, true)
	command := exec.Command(os.Args[0], "-test.run=^TestPromptExitHelper$")
	command.Env = append(os.Environ(), promptExitHelperEnv+"=1", "ION_SOCKET_PATH="+addr, "ION_DATA_DIR="+t.TempDir())
	var stderr strings.Builder
	command.Stderr = &stderr
	err := command.Run()
	code := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else if err != nil {
		t.Fatalf("prompt command: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(stderr.String()), "\n")
	last := lines[len(lines)-1]
	if !strings.HasPrefix(last, runReportPrefix) {
		return code, nil, stderr.String()
	}
	var r runReport
	if err := json.Unmarshal([]byte(strings.TrimPrefix(last, runReportPrefix)), &r); err != nil {
		t.Fatalf("run report %q: %v", last, err)
	}
	return code, &r, stderr.String()
}

// TestAFinishedRunEndsWithItsReport pins the report a finished run prints:
// the model its statuses named, its cost, turns, and usage.
func TestAFinishedRunEndsWithItsReport(t *testing.T) {
	code, r, out := runReportOf(t, []string{
		`{"type":"engine_status","fields":{"state":"running","model":"claude-sonnet-5-5"}}`,
		`{"type":"engine_text_delta","text":"done"}`,
		closingStatus,
	})
	want := runReport{Model: "claude-sonnet-5-5", CostUsd: 0.42, Turns: 3, DurationMs: 4200, InputTokens: 100, OutputTokens: 20, CacheReadTokens: 5000, CacheCreationTokens: 300, Reason: "completed"}
	if code != 0 || r == nil || *r != want {
		t.Fatalf("exit %d, report %+v, want exit 0 and %+v; stderr:\n%s", code, r, want, out)
	}
}

// TestARunStoppedAtItsBudgetStillReportsWhatItSpent pins that an error is
// followed by the run's close, and the report is read from it: a run the
// engine stopped at its budget still says what it spent.
func TestARunStoppedAtItsBudgetStillReportsWhatItSpent(t *testing.T) {
	code, r, out := runReportOf(t, []string{
		`{"type":"engine_status","fields":{"state":"running","model":"claude-sonnet-5-5"}}`,
		`{"type":"engine_error","message":"budget exceeded: $0.4200 >= $0.4000","errorCode":"budget_exceeded"}`,
		closingStatus,
	})
	if code != 1 || r == nil || r.CostUsd != 0.42 || r.Model != "claude-sonnet-5-5" {
		t.Fatalf("exit %d, report %+v, want exit 1 and the run's cost; stderr:\n%s", code, r, out)
	}
	if !strings.Contains(out, "Error: budget exceeded: $0.4200 >= $0.4000") {
		t.Errorf("the error line is gone:\n%s", out)
	}
}

// TestARunNeverClosedPrintsNoReport pins that no figure is made up: a run
// whose close the CLI never saw prints no report.
func TestARunNeverClosedPrintsNoReport(t *testing.T) {
	for name, events := range map[string][]string{
		"error, then the stream ends": {`{"type":"engine_error","message":"provider unavailable"}`},
		"the session dies":            {`{"type":"engine_dead"}`},
		"an idle with no run closed":  {`{"type":"engine_status","fields":{"state":"idle"}}`},
	} {
		t.Run(name, func(t *testing.T) {
			if _, r, out := runReportOf(t, events); r != nil {
				t.Fatalf("report %+v printed for a run never closed; stderr:\n%s", r, out)
			}
		})
	}
}

// TestTheWaitForACloseKeepsTheStreamsDeadline pins that the wait for a
// close after an error never outlasts the prompt's own deadline.
func TestTheWaitForACloseKeepsTheStreamsDeadline(t *testing.T) {
	addr := serveStreamEvents(t, nil, []string{`{"type":"engine_error","message":"provider unavailable"}`}, false)
	stream := openTestPromptStream(t, addr, 300*time.Millisecond)
	start := time.Now()
	if got := streamUntilIdle(stream, promptExitKey); got != streamFailed {
		t.Fatalf("streamUntilIdle = %v, want streamFailed", got)
	}
	if waited := time.Since(start); waited > 800*time.Millisecond {
		t.Errorf("waited %s past a 300ms deadline for a close the held stream never sent", waited)
	}
}

// TestAParkedRunIsFollowedToTheCloseOfItsWake pins that a run parked on
// background commands is not over. The engine says so with an idle status
// that holds pending work; the CLI keeps following, prints the woken run's
// words, and ends with that run's report. Ending at the park left the
// commands to be reaped with the session and the run's spend unread.
func TestAParkedRunIsFollowedToTheCloseOfItsWake(t *testing.T) {
	code, r, out := runReportOf(t, []string{
		`{"type":"engine_status","fields":{"state":"running","model":"claude-opus-5-5"}}`,
		`{"type":"engine_text_delta","text":"the check runs in the background"}`,
		`{"type":"engine_task_suspended","taskSuspendAwaitingTaskCount":1}`,
		`{"type":"engine_status","fields":{"state":"idle","model":"claude-opus-5-5","backgroundShells":1,"hasPendingWork":true}}`,
		`{"type":"engine_status","fields":{"state":"running","model":"claude-opus-5-5"}}`,
		`{"type":"engine_text_delta","text":"the check passed"}`,
		closingStatus,
	})
	if code != 0 || r == nil || r.CostUsd != 0.42 || r.Turns != 3 || r.Model != "claude-opus-5-5" {
		t.Fatalf("exit %d, report %+v, want exit 0 and the woken run's close; stderr:\n%s", code, r, out)
	}
}
