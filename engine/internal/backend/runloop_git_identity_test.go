package backend

// FR-04's tool-loop enforcement: a git-mutating Bash subcommand is refused
// when the run's git identity is required but unresolved. These pin that
// the wiring in checkContainmentBoundaries/executeTools actually consults
// RunConfig.GitIdentityRequiredUnresolved, records the refusal, and emits
// the git_identity_unresolved failure category -- mirroring the workspace
// containment tests in runloop_workspaces_test.go.

import (
	"context"
	"runtime"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteTools_GitIdentityRequiredRefusesCommit pins the refusal path:
// a Bash call invoking `git commit` must come back as an error result
// carrying the typed reason, with the git_identity_unresolved failure
// category emitted, and the command must never execute.
func TestExecuteTools_GitIdentityRequiredRefusesCommit(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "git-id-req",
		conv:      &conversation.Conversation{ID: "conv-git-id"},
		cfg:       &RunConfig{Telemetry: telem, GitIdentityRequiredUnresolved: true},
	}
	dir := t.TempDir()
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-git-commit",
		Input: map[string]interface{}{"command": `git commit -m "test"`},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected one error result, got %+v", results)
	}
	if !strings.Contains(results[0].Content, "commit") {
		t.Errorf("refusal must name the refused subcommand: %s", results[0].Content)
	}
	if !failureCategories(telem)["git_identity_unresolved"] {
		t.Error("expected a tool.failure event with category git_identity_unresolved")
	}
}

// TestExecuteTools_GitIdentityRequiredAllowsReadOnlyGit pins that a
// non-mutating git subcommand (status) is never refused by this gate, even
// when identity is required and unresolved -- FR-04 only gates the moment
// an identity would actually be recorded into history.
func TestExecuteTools_GitIdentityRequiredAllowsReadOnlyGit(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "git-id-ro-req",
		conv:      &conversation.Conversation{ID: "conv-git-id-ro"},
		cfg:       &RunConfig{Telemetry: telem, GitIdentityRequiredUnresolved: true},
	}
	dir := t.TempDir()
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-git-status",
		Input: map[string]interface{}{"command": "git status"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result, got %+v", results)
	}
	if failureCategories(telem)["git_identity_unresolved"] {
		t.Error("read-only git status must never be refused by the git identity gate")
	}
}

// TestExecuteTools_GitIdentityNotRequiredAllowsCommit pins the negative:
// when GitIdentityRequiredUnresolved is false (identity resolved, or not
// required at all), a git-mutating command is never refused by this gate.
func TestExecuteTools_GitIdentityNotRequiredAllowsCommit(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "git-id-ok-req",
		conv:      &conversation.Conversation{ID: "conv-git-id-ok"},
		cfg:       &RunConfig{Telemetry: telem},
	}
	dir := t.TempDir()
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-git-commit-ok",
		Input: map[string]interface{}{"command": `git commit -m "test"`},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result, got %+v", results)
	}
	if failureCategories(telem)["git_identity_unresolved"] {
		t.Error("commit must not be refused by the git identity gate when identity is not required-and-unresolved")
	}
}

// TestExecuteTools_GitIdentityToolEnvReachesBashSubprocess pins that
// RunConfig.ToolEnv actually reaches the Bash tool's subprocess environment
// -- the FR-04 mechanism this whole gate exists to protect. A shell command
// that echoes the injected variable must see it.
func TestExecuteTools_GitIdentityToolEnvReachesBashSubprocess(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "git-id-env-req",
		conv:      &conversation.Conversation{ID: "conv-git-id-env"},
		cfg: &RunConfig{
			Telemetry: &mockTelemetry{},
			ToolEnv:   map[string]string{"GIT_AUTHOR_NAME": "Jane Principal"},
		},
	}
	dir := t.TempDir()
	command := "echo $GIT_AUTHOR_NAME"
	if runtime.GOOS == "windows" {
		// PowerShell reads an environment variable via $env:NAME, not $NAME.
		command = "echo $env:GIT_AUTHOR_NAME"
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-git-env",
		Input: map[string]interface{}{"command": command},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].IsError {
		t.Fatalf("expected a successful result, got %+v", results)
	}
	if !strings.Contains(results[0].Content, "Jane Principal") {
		t.Errorf("expected the stamped ToolEnv to reach the Bash subprocess, got %q", results[0].Content)
	}
}
