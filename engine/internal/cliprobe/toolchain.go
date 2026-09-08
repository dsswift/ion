package cliprobe

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/dsswift/ion/engine/internal/utils"
)

// lookPath is exec.LookPath, indirected only so it reads as a named search
// step alongside toolchainCandidates below.
func lookPath(name string) (string, error) { return exec.LookPath(name) }

// FindToolchain resolves a build toolchain binary (node, esbuild) needed by
// the extension host to run or transpile extensions. Unlike Find (delegated
// CLIs), a toolchain miss means the extension host cannot start at all, so
// callers propagate the error rather than falling through to a degraded run.
//
// Search order: exec.LookPath first (PATHEXT-aware on windows, so a bare
// "node" resolves node.exe there), then toolchainCandidates(name) — the
// daemon-mode fallback locations for when PATH is not the interactive
// shell's PATH (unix: /opt/homebrew/bin, /usr/local/bin; windows:
// %ProgramFiles%\nodejs, %APPDATA%\npm, %LOCALAPPDATA%\Programs\nodejs).
func FindToolchain(name string) (string, error) {
	if p, err := lookPath(name); err == nil {
		utils.LogWithFields(utils.LevelInfo, "cliprobe", "toolchain resolved", map[string]any{
			"name": name, "path": p, "source": "path",
		})
		return p, nil
	}
	candidates := toolchainCandidates(name, os.Getenv)
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			utils.LogWithFields(utils.LevelInfo, "cliprobe", "toolchain resolved", map[string]any{
				"name": name, "path": candidate, "source": "candidate",
			})
			return candidate, nil
		}
	}
	utils.LogWithFields(utils.LevelError, "cliprobe", "toolchain not found", map[string]any{
		"name": name, "searched": toolchainSearchDescription(),
	})
	return "", fmt.Errorf("%s not found: checked %s", name, toolchainSearchDescription())
}
