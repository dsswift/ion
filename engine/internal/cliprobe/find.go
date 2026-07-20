// Package cliprobe locates and interrogates the provider CLIs the engine
// delegates to (claude, codex, grok, cursor's agent). Find is the binary
// discovery primitive; later files add per-backend install/auth probing and a
// cached registry.
package cliprobe

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Find locates a CLI binary by name. Search order (first hit wins):
//  1. /usr/local/bin/<name>
//  2. /opt/homebrew/bin/<name>
//  3. ~/.npm-global/bin/<name>
//  4. any caller-supplied extra candidate paths (checked before $PATH)
//  5. exec.LookPath (current $PATH)
//  6. login-shell fallback (zsh/bash -l -c "which <name>"), which covers
//     installs whose PATH is set only in shell profiles (Unix only)
//
// This generalizes the claude-specific discovery the claude-code backend
// shipped so every delegated CLI resolves the same way.
func Find(name string, extra []string) (string, error) {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	candidates := []string{
		filepath.Join("/usr/local/bin", name),
		filepath.Join("/opt/homebrew/bin", name),
		filepath.Join(home, ".npm-global", "bin", name),
	}
	candidates = append(candidates, extra...)
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
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
					return p, nil
				}
			}
		}
	}
	return "", fmt.Errorf("%s CLI not found: checked standard install paths, $PATH, and login shell", name)
}
