package plugins

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RunHookCommand executes a plugin hook command with no stdin, captures stdout,
// and returns it. pluginRoot is the installed plugin directory (substituted for
// ${CLAUDE_PLUGIN_ROOT}). Non-zero exit codes are logged and skipped (return "", nil).
//
// Use this for SessionStart hooks, which read no stdin. For UserPromptSubmit
// hooks, use RunHookCommandWithStdin to pass the prompt JSON payload.
func RunHookCommand(entry PluginHookEntry, pluginRoot string, extraEnv []string) (string, error) {
	return RunHookCommandWithStdin(entry, pluginRoot, extraEnv, "")
}

// RunHookCommandWithStdin executes a plugin hook command, writes stdinData to
// the subprocess stdin (when non-empty), captures stdout, and returns it.
//
// Claude Code's hook protocol pipes {"prompt": "...", "transcript_path": "..."}
// as JSON to UserPromptSubmit hook stdin. Without this, hooks that read stdin
// (like caveman-mode-tracker.js) receive an immediate EOF, fail JSON.parse, and
// silently produce no output — suppressing both mode-switching and per-turn
// reinforcement.
//
// pluginRoot is the installed plugin directory (substituted for
// ${CLAUDE_PLUGIN_ROOT}). Non-zero exit codes are logged and skipped (return "", nil).
func RunHookCommandWithStdin(entry PluginHookEntry, pluginRoot string, extraEnv []string, stdinData string) (string, error) {
	timeout := entry.EffectiveTimeout()
	cmd := expandPluginRoot(entry.Command, pluginRoot)
	return runCommand(cmd, pluginRoot, timeout, extraEnv, stdinData)
}

// expandPluginRoot replaces ${CLAUDE_PLUGIN_ROOT} in a command string.
func expandPluginRoot(cmd, pluginRoot string) string {
	return strings.ReplaceAll(cmd, "${CLAUDE_PLUGIN_ROOT}", pluginRoot)
}

func runCommand(cmdStr, pluginRoot string, timeout time.Duration, extraEnv []string, stdinData string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	parts := splitCommand(cmdStr)
	if len(parts) == 0 {
		return "", fmt.Errorf("empty hook command")
	}

	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)

	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	claudeDir := filepath.Join(home, ".claude")
	ionDir := filepath.Join(home, ".ion")

	cmd.Env = append(os.Environ(),
		"CLAUDE_PLUGIN_ROOT="+pluginRoot,
		"ION_PLUGIN_ROOT="+pluginRoot,
		"CLAUDE_CONFIG_DIR="+claudeDir,
		"ION_CONFIG_DIR="+ionDir,
	)
	cmd.Env = append(cmd.Env, extraEnv...)

	// When stdinData is non-empty, pipe it to the subprocess. This implements
	// Claude Code's hook stdin protocol: UserPromptSubmit hooks receive the
	// prompt payload as JSON on stdin rather than reading it from args or env.
	if stdinData != "" {
		cmd.Stdin = strings.NewReader(stdinData)
	}

	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Stderr goes to /dev/null (nil) so hook script noise doesn't pollute logs.

	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			utils.LogWithFields(utils.LevelInfo, "plugins", "hook command timed out", map[string]any{
				"cmd": cmdStr, "timeout": timeout,
			})
			return "", nil
		}
		// Non-zero exit: log and skip, never abort the session.
		utils.LogWithFields(utils.LevelInfo, "plugins", "hook command exited non-zero", map[string]any{
			"cmd": cmdStr, "error": err.Error(),
		})
		return "", nil
	}

	return strings.TrimRight(stdout.String(), "\n"), nil
}

// splitCommand splits a shell-style command string on whitespace, respecting
// simple double-quoted tokens. Does not handle backslash escapes or single
// quotes — sufficient for the hook command strings in the wild.
func splitCommand(s string) []string {
	var parts []string
	var cur strings.Builder
	inQuote := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' && !inQuote:
			inQuote = true
		case c == '"' && inQuote:
			inQuote = false
		case c == ' ' && !inQuote:
			if cur.Len() > 0 {
				parts = append(parts, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteByte(c)
		}
	}
	if cur.Len() > 0 {
		parts = append(parts, cur.String())
	}
	return parts
}
