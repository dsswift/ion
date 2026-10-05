// Package testhome isolates a test binary from the operator's real engine
// data root.
//
// Every engine path under the data root (conversations, engine.json, MCP
// sockets, session bindings) resolves through utils.IonDir, which reads
// ION_DATA_DIR first and HOME second. A test that runs a session, a backend
// run loop, or a dispatch without pinning both writes into the real store of
// whoever runs `go test`. A package that calls Run from its TestMain gets a
// temp HOME and a cleared ION_DATA_DIR for its whole binary, so no test in
// that package, present or future, can reach the real data root by default.
//
// Individual tests that need their own HOME or ION_DATA_DIR still call
// t.Setenv; that takes precedence for the duration of the test.
package testhome

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Run isolates the process, runs the package's tests, restores the
// environment, and returns the exit code for os.Exit. prefix names the temp
// HOME directory ("ionh-") and should stay short: the CLI tool server's
// socket lives at <home>/.ion/mcp/sock-<64-hex-digest>, a 74-byte suffix
// that must fit the ~104-byte Unix socket path limit.
func Run(m *testing.M, prefix string) int {
	restore, err := Enter(prefix)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testhome: %v\n", err)
		return 1
	}
	code := m.Run()
	restore()
	return code
}

// Enter creates a temp HOME under ShortRoot, points HOME at it, and unsets
// ION_DATA_DIR. The returned restore puts both variables back and removes
// the temp HOME. Run is the TestMain entry point; Enter exists so the
// isolation itself can be tested.
func Enter(prefix string) (restore func(), err error) {
	home, err := os.MkdirTemp(ShortRoot(), prefix)
	if err != nil {
		return nil, fmt.Errorf("cannot create temp HOME: %w", err)
	}
	home = ShortenPath(home)

	origHome, hadHome := os.LookupEnv("HOME")
	origData, hadData := os.LookupEnv("ION_DATA_DIR")
	if err := os.Setenv("HOME", home); err != nil {
		os.RemoveAll(home) //nolint:errcheck // best-effort cleanup on a failed setup
		return nil, fmt.Errorf("cannot set HOME: %w", err)
	}
	if err := os.Unsetenv("ION_DATA_DIR"); err != nil {
		resetEnv("HOME", origHome, hadHome)
		os.RemoveAll(home) //nolint:errcheck // best-effort cleanup on a failed setup
		return nil, fmt.Errorf("cannot unset ION_DATA_DIR: %w", err)
	}

	return func() {
		resetEnv("HOME", origHome, hadHome)
		resetEnv("ION_DATA_DIR", origData, hadData)
		if err := os.RemoveAll(home); err != nil {
			fmt.Fprintf(os.Stderr, "testhome: cannot remove temp HOME %s: %v\n", home, err)
		}
	}, nil
}

// RunDataDir isolates only the engine data root: it points ION_DATA_DIR at a
// temp dir and leaves HOME alone. It is for packages whose tests drive real
// tools that read the operator's HOME (a delegated CLI's sign-in, for
// example), where Run's temp HOME would break them. The conversation store
// and every other IonDir path still land in the temp dir.
func RunDataDir(m *testing.M, prefix string) int {
	restore, err := EnterDataDir(prefix)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testhome: %v\n", err)
		return 1
	}
	code := m.Run()
	restore()
	return code
}

// EnterDataDir creates a temp data root and points ION_DATA_DIR at it. The
// returned restore puts ION_DATA_DIR back and removes the temp dir.
func EnterDataDir(prefix string) (restore func(), err error) {
	dir, err := os.MkdirTemp(ShortRoot(), prefix)
	if err != nil {
		return nil, fmt.Errorf("cannot create temp data root: %w", err)
	}
	dir = ShortenPath(dir)
	origData, hadData := os.LookupEnv("ION_DATA_DIR")
	if err := os.Setenv("ION_DATA_DIR", dir); err != nil {
		os.RemoveAll(dir) //nolint:errcheck // best-effort cleanup on a failed setup
		return nil, fmt.Errorf("cannot set ION_DATA_DIR: %w", err)
	}
	return func() {
		resetEnv("ION_DATA_DIR", origData, hadData)
		if err := os.RemoveAll(dir); err != nil {
			fmt.Fprintf(os.Stderr, "testhome: cannot remove temp data root %s: %v\n", dir, err)
		}
	}, nil
}

// resetEnv restores one variable to its pre-Enter state. TestMain has no
// logger, so a failure goes to stderr where `go test` shows it.
func resetEnv(key, value string, had bool) {
	var err error
	if had {
		err = os.Setenv(key, value)
	} else {
		err = os.Unsetenv(key)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "testhome: cannot restore %s: %v\n", key, err)
	}
}

// UnwritableTempDir points os.TempDir at a directory that does not exist for
// the rest of the test, so any file created there fails. os.TempDir reads
// TMPDIR on Unix and TMP, then TEMP, on Windows; all three are set so the
// same test fails the same way on every OS.
func UnwritableTempDir(t testing.TB) {
	t.Helper()
	missing := filepath.Join(t.TempDir(), "missing")
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(key, missing)
	}
}
