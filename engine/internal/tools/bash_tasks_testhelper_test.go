package tools

// Shared test reset for the package-global bash task registry.
//
// This lived in bash_background_test.go, which is !windows because its tests
// drive POSIX shell commands and probe liveness with syscall.Kill. The helper
// touches neither -- it only clears a map -- but three other test files call
// it, and two of them are platform-neutral. The result was that the whole
// package failed to build on Windows with `undefined: clearBashTasks`, so no
// test in it could run there at all. Keeping the helper unconstrained is what
// lets the portable tests cover Windows.

import "testing"

// clearBashTasks removes all Kind=="bash" tasks between tests (the registry
// is package-global).
func clearBashTasks(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		tasksMu.Lock()
		for id, task := range tasks {
			if task.Kind == "bash" {
				if task.stop != nil {
					task.stop()
				}
				delete(tasks, id)
			}
		}
		tasksMu.Unlock()
	})
}
