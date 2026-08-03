//go:build integration

package integration

// Shared helpers for integration tests that load real TypeScript extensions
// through the subprocess host and speak the NDJSON socket protocol.

import (
	"os/exec"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

// requireEsbuild skips the test when esbuild is not installed — loading a
// TypeScript extension requires the transpiler.
func requireEsbuild(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("esbuild"); err != nil {
		t.Skip("esbuild not installed, skipping TypeScript extension test")
	}
}

func toolNames(tools []extension.ToolDefinition) []string {
	names := make([]string, len(tools))
	for i, tool := range tools {
		names[i] = tool.Name
	}
	return names
}

func cmdNames(cmds map[string]extension.CommandDefinition) []string {
	names := make([]string, 0, len(cmds))
	for k := range cmds {
		names = append(names, k)
	}
	return names
}
