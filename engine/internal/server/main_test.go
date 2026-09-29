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
// same fix for the same reason: testhome.Run redirects HOME and clears
// ION_DATA_DIR for the whole package.
//
// Individual tests that need their own HOME still call t.Setenv("HOME", ...);
// that continues to work and takes precedence for the duration of the test.
import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/testhome"
)

func TestMain(m *testing.M) {
	// Every server built in this package would otherwise spawn the real
	// delegated CLIs installed on the machine (grok, claude, codex) to probe
	// them. A real CLI writes into HOME, which is a test's temp directory,
	// while that directory is being removed, and the test then fails on
	// cleanup. Tests that want a probe result install their own function.
	newProbeRegistry = func() *cliprobe.Registry {
		reg := cliprobe.NewRegistry()
		reg.SetProbeFunc(func(kind string) cliprobe.Probe { return cliprobe.Probe{Kind: kind} })
		return reg
	}

	// "ionsrv-" stays short: this HOME is the base for the ToolServer
	// tests' Unix socket, which must fit the socket path limit.
	os.Exit(testhome.Run(m, "ionsrv-"))
}
