package server

// main_test.go — package-wide test isolation.
//
// Several tests in this package start a real session or ToolServer against
// the process's real HOME unless something overrides it, and several of
// them read/write ~/.ion/engine.json through that same HOME. A contributor
// (or CI runner) whose real profile has an MCP server configured -- even a
// stray leftover from unrelated manual testing -- changes what those tests
// observe: TestDispatchSendPromptDeliveryIDIsIdempotent tried to dial one
// and hung for its full timeout instead of completing. internal/session hit
// the identical trap and fixed it the same way (see that package's
// main_test.go comment for the original incident); this package needed the
// same fix for the same reason.
//
// Individual tests that need their own HOME still call t.Setenv("HOME", ...);
// that continues to work and takes precedence for the duration of the test.
import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// shortTempRoot (server_test.go) keeps this under the ~104-byte Unix
	// socket path limit that this package's ToolServer tests also have to
	// respect (~/.ion/mcp/sock-<64-hex-digest>). shortenWindowsPath applies
	// the 8.3 alias on top, matching internal/session's identical need.
	//
	// Not t.TempDir(): TestMain has no *testing.T, so the directory is
	// created and removed explicitly.
	tmpHome, err := os.MkdirTemp(shortTempRoot(), "ionsrv-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "server tests: cannot create temp HOME: %v\n", err)
		os.Exit(1)
	}
	tmpHome = shortenWindowsPath(tmpHome)

	originalHome, hadHome := os.LookupEnv("HOME")
	if err := os.Setenv("HOME", tmpHome); err != nil {
		fmt.Fprintf(os.Stderr, "server tests: cannot set HOME: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()

	// Restore and clean up before exiting. os.Exit skips defers, so this runs
	// inline after m.Run returns.
	if hadHome {
		if err := os.Setenv("HOME", originalHome); err != nil {
			fmt.Fprintf(os.Stderr, "server tests: cannot restore HOME: %v\n", err)
		}
	} else if err := os.Unsetenv("HOME"); err != nil {
		fmt.Fprintf(os.Stderr, "server tests: cannot unset HOME: %v\n", err)
	}
	if err := os.RemoveAll(tmpHome); err != nil {
		fmt.Fprintf(os.Stderr, "server tests: cannot remove temp HOME %s: %v\n", tmpHome, err)
	}

	os.Exit(code)
}
