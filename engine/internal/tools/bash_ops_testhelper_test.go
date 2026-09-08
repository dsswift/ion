package tools

// Shared BashOperations stub for tests that assert on what the tool would
// spawn without spawning anything.
//
// This lived in bash_sleep_gate_test.go, which is !windows because its own
// tests drive POSIX shell commands. The stub drives nothing -- it records
// calls and returns a canned result -- but bash_timeout_cap_test.go is
// platform-neutral and depends on it, so the constraint made the whole package
// fail to build on Windows with `undefined: recordingOps`. Keeping the stub
// unconstrained is what lets the portable tests run there.

import (
	"context"
	"sync"
	"testing"
)

// recordingOps is a BashOperations stub that records every invocation. It is
// how the "blocked" tests prove no process was spawned — asserting only on the
// message would pass against a gate that logs a refusal and executes anyway.
type recordingOps struct {
	mu       sync.Mutex
	calls    []ExecOptions
	commands []string
	result   *ExecResult
	err      error
}

func (r *recordingOps) Exec(_ context.Context, command, _ string, opts ExecOptions) (*ExecResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, opts)
	r.commands = append(r.commands, command)
	if r.result != nil || r.err != nil {
		return r.result, r.err
	}
	return &ExecResult{Stdout: "stub-ran"}, nil
}

func (r *recordingOps) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func (r *recordingOps) lastOptions(t *testing.T) ExecOptions {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) == 0 {
		t.Fatal("backend was never invoked")
	}
	return r.calls[len(r.calls)-1]
}

// installRecordingOps swaps in the stub backend for the duration of a test.
func installRecordingOps(t *testing.T, ops *recordingOps) {
	t.Helper()
	prev := GetBashOperations()
	SetBashOperations(ops)
	t.Cleanup(func() { SetBashOperations(prev) })
}
