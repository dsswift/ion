package tools

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

func TestBashExecutionEnvCarriesSourceSession(t *testing.T) {
	ctx := utils.WithSessionID(context.Background(), "source-session")

	env := bashExecutionEnv(ctx)

	if got := env["ION_SESSION_ID"]; got != "source-session" {
		t.Errorf("ION_SESSION_ID = %q, want source session", got)
	}
}

func TestBashExecutionEnvCarriesSourceSessionIntoChild(t *testing.T) {
	ctx := utils.WithSessionID(context.Background(), "source-session")
	result, err := executeBash(ctx, map[string]any{"command": "printf %s \"$ION_SESSION_ID\""}, t.TempDir())
	if err != nil {
		t.Fatalf("executeBash returned error: %v", err)
	}
	if result.IsError {
		t.Fatalf("executeBash reported tool error: %s", result.Content)
	}
	if result.Content != "source-session" {
		t.Errorf("Bash child received %q, want source session", result.Content)
	}
}
func TestBashExecutionEnvOmitsAbsentSourceSession(t *testing.T) {
	if env := bashExecutionEnv(context.Background()); env != nil {
		t.Errorf("bashExecutionEnv() = %v, want nil without a source session", env)
	}
}
