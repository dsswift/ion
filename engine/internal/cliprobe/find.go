// Package cliprobe locates and interrogates the provider CLIs the engine
// delegates to (claude, codex, grok, cursor's agent). Find is the binary
// discovery primitive; later files add per-backend install/auth probing and a
// cached registry.
package cliprobe

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Find locates a CLI binary by name. Search order (first hit wins):
//  1. installCandidates(name) — platform-specific fixed install locations
//     (unix: /usr/local/bin, /opt/homebrew/bin, ~/.npm-global/bin; windows:
//     %APPDATA%\npm, %USERPROFILE%\.local\bin, %LOCALAPPDATA%\Programs,
//     %ProgramFiles%)
//  2. any caller-supplied extra candidate paths (checked before $PATH)
//  3. exec.LookPath (current $PATH; PATHEXT-aware on windows, so
//     claude.cmd/codex.cmd/node.exe resolve from a bare name there)
//  4. login-shell fallback (zsh/bash -l -c "which <name>"), which covers
//     installs whose PATH is set only in shell profiles (unix only; there is
//     no equivalent concept of a login shell on windows)
//
// This generalizes the claude-specific discovery the claude-code backend
// shipped so every delegated CLI resolves the same way.
func Find(name string, extra []string) (string, error) {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	candidates := installCandidates(name, os.Getenv, home)
	candidates = append(candidates, extra...)
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			utils.LogWithFields(utils.LevelInfo, "cliprobe", "cli resolved", map[string]any{
				"name": name, "path": p, "source": "candidate",
			})
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		utils.LogWithFields(utils.LevelInfo, "cliprobe", "cli resolved", map[string]any{
			"name": name, "path": p, "source": "path",
		})
		return p, nil
	}
	if runtime.GOOS != "windows" {
		for _, shell := range []string{"zsh", "bash"} {
			shellPath, err := exec.LookPath(shell)
			if err != nil {
				continue
			}
			out, err := exec.Command(shellPath, "-l", "-c", "which "+name+" 2>/dev/null").Output()
			if err != nil {
				continue
			}
			if p := strings.TrimSpace(string(out)); p != "" {
				if _, err := os.Stat(p); err == nil {
					utils.LogWithFields(utils.LevelInfo, "cliprobe", "cli resolved", map[string]any{
						"name": name, "path": p, "source": "login-shell",
					})
					return p, nil
				}
			}
		}
	}
	return "", fmt.Errorf("%s CLI not found: checked %s", name, searchDescription())
}
