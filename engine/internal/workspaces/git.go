package workspaces

import (
	"os/exec"
)

// gitRunner runs a git command in a directory and returns stdout. The error
// carries a non-zero exit. Swappable for tests. Deliberately NOT
// context-aware: it runs on the refusal path, where a cancellable guard is
// not a guard.
type gitRunner func(dir string, args ...string) (string, error)

func runGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return string(out), err
}
