package plugins

import (
	"os"
	"testing"
	"time"
)

func TestRunHookCommand_Echo(t *testing.T) {
	entry := PluginHookEntry{
		Type:    "command",
		Command: "echo hello",
		Timeout: 5,
	}
	out, err := RunHookCommand(entry, "/tmp", nil)
	if err != nil {
		t.Fatalf("RunHookCommand: %v", err)
	}
	if out != "hello" {
		t.Errorf("got %q, want %q", out, "hello")
	}
}

func TestRunHookCommand_PluginRootEnv(t *testing.T) {
	// Verify CLAUDE_PLUGIN_ROOT is set in the environment.
	// Use double quotes so splitCommand (which handles double quotes, not single)
	// passes "echo $CLAUDE_PLUGIN_ROOT" as one argument to sh -c.
	entry := PluginHookEntry{
		Type:    "command",
		Command: `sh -c "echo $CLAUDE_PLUGIN_ROOT"`,
		Timeout: 5,
	}
	out, err := RunHookCommand(entry, "/my/plugin/root", nil)
	if err != nil {
		t.Fatalf("RunHookCommand: %v", err)
	}
	if out != "/my/plugin/root" {
		t.Errorf("CLAUDE_PLUGIN_ROOT = %q, want %q", out, "/my/plugin/root")
	}
}

func TestRunHookCommand_Timeout(t *testing.T) {
	entry := PluginHookEntry{
		Type:    "command",
		Command: "sleep 60",
		Timeout: 1, // 1 second — will time out
	}
	start := time.Now()
	out, err := RunHookCommand(entry, "/tmp", nil)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("RunHookCommand: %v", err)
	}
	if out != "" {
		t.Errorf("timed-out hook should return empty, got %q", out)
	}
	if elapsed > 5*time.Second {
		t.Errorf("timeout took too long: %v", elapsed)
	}
}

func TestRunHookCommand_NonZeroExit(t *testing.T) {
	entry := PluginHookEntry{
		Type:    "command",
		Command: `sh -c "exit 1"`,
		Timeout: 5,
	}
	out, err := RunHookCommand(entry, "/tmp", nil)
	if err != nil {
		t.Fatalf("non-zero exit should not return error to caller: %v", err)
	}
	if out != "" {
		t.Errorf("non-zero exit should return empty output, got %q", out)
	}
}

func TestRunHookCommand_PluginRootExpansion(t *testing.T) {
	// Write a small script that prints its own path.
	dir := t.TempDir()
	scriptPath := dir + "/greet.sh"
	os.WriteFile(scriptPath, []byte("#!/bin/sh\necho from-plugin"), 0o755)

	entry := PluginHookEntry{
		Type:    "command",
		Command: "${CLAUDE_PLUGIN_ROOT}/greet.sh",
		Timeout: 5,
	}
	out, err := RunHookCommand(entry, dir, nil)
	if err != nil {
		t.Fatalf("RunHookCommand: %v", err)
	}
	if out != "from-plugin" {
		t.Errorf("got %q, want %q", out, "from-plugin")
	}
}
