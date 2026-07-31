package session

// main_test.go — package-wide test isolation.
//
// Every test in this package that starts a session runs against the process's
// real HOME unless it overrides it. That used to be harmless: StartSession read
// its MCP server list from the boot-cached config a test never populated.
// StartSession now resolves the list FRESH from ~/.ion/engine.json (so that
// `ion mcp add` takes effect without a daemon restart), which means a developer
// with a configured MCP server changes what these tests observe — a session with
// a server emits an extra "Connecting MCP servers..." event, and would try to
// dial that server during the test.
//
// TestOnEvent_ReplaceCallback caught this by asserting an exact event count: it
// passed in CI and on a clean machine, and failed on a machine with an MCP
// server configured. Rather than adding t.Setenv("HOME", ...) to the ~40 test
// files that call StartSession — which leaves the next new test exposed to the
// same trap — HOME is redirected once here, for the whole package.
//
// Individual tests that need their own HOME still call t.Setenv("HOME", ...);
// that continues to work and takes precedence for the duration of the test.

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// A temp HOME for the package, deliberately created under /tmp with a SHORT
	// prefix. This HOME is the base for the CLI tool server's Unix socket at
	// ~/.ion/mcp/sock-<64-hex-digest>, so the total path must stay inside the
	// ~104-byte sun_path limit or the socket cannot bind. The fixed suffix costs
	// 74 bytes, which leaves very little room: macOS's default temp root
	// (/var/folders/<...>/T/) overruns it on its own, and even "/tmp" with a
	// verbose prefix lands at 111. "ionh-" keeps it near 99. Same constraint
	// internal/server's newShortPathTestServer works around.
	//
	// Not t.TempDir(): TestMain has no *testing.T, so the directory is created
	// and removed explicitly.
	tmpHome, err := os.MkdirTemp("/tmp", "ionh-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "session tests: cannot create temp HOME: %v\n", err)
		os.Exit(1)
	}

	originalHome, hadHome := os.LookupEnv("HOME")
	if err := os.Setenv("HOME", tmpHome); err != nil {
		fmt.Fprintf(os.Stderr, "session tests: cannot set HOME: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()

	// Restore and clean up before exiting. os.Exit skips defers, so this runs
	// inline after m.Run returns.
	if hadHome {
		if err := os.Setenv("HOME", originalHome); err != nil {
			fmt.Fprintf(os.Stderr, "session tests: cannot restore HOME: %v\n", err)
		}
	} else if err := os.Unsetenv("HOME"); err != nil {
		fmt.Fprintf(os.Stderr, "session tests: cannot unset HOME: %v\n", err)
	}
	if err := os.RemoveAll(tmpHome); err != nil {
		fmt.Fprintf(os.Stderr, "session tests: cannot remove temp HOME %s: %v\n", tmpHome, err)
	}

	os.Exit(code)
}
