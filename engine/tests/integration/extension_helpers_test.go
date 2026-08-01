//go:build integration

package integration

// Shared helpers for integration tests that load real TypeScript extensions
// through the subprocess host and speak the NDJSON socket protocol.

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/protocol"
)

// requireEsbuild skips the test when esbuild is not installed — loading a
// TypeScript extension requires the transpiler.
func requireEsbuild(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("esbuild"); err != nil {
		t.Skip("esbuild not installed, skipping TypeScript extension test")
	}
}

// findResultLine scans lines for a {"cmd":"result"} response and returns it.
func findResultLine(t *testing.T, lines []string) *protocol.ServerResult {
	t.Helper()
	for _, l := range lines {
		if strings.Contains(l, `"cmd":"result"`) {
			var r protocol.ServerResult
			if err := json.Unmarshal([]byte(l), &r); err != nil {
				t.Fatalf("unmarshal result: %v", err)
			}
			return &r
		}
	}
	return nil
}

// findSessionList scans lines for a {"cmd":"session_list"} response.
func findSessionList(t *testing.T, lines []string) *protocol.ServerSessionList {
	t.Helper()
	for _, l := range lines {
		if strings.Contains(l, `"cmd":"session_list"`) {
			var r protocol.ServerSessionList
			if err := json.Unmarshal([]byte(l), &r); err != nil {
				t.Fatalf("unmarshal session_list: %v", err)
			}
			return &r
		}
	}
	return nil
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
