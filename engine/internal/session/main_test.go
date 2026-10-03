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
// server configured. Rather than adding t.Setenv("HOME", ...) to every test file
// that calls StartSession — which leaves the next new test exposed to the same
// trap — HOME is redirected (and ION_DATA_DIR cleared) once here, for the
// whole package, through testhome.Run.
//
// Individual tests that need their own HOME still call t.Setenv("HOME", ...);
// that continues to work and takes precedence for the duration of the test.

// The heartbeat is parked for the same reason. Most tests here never call
// Manager.Shutdown, and many hand the Manager a session literal that holds only
// the fields the test reads. A Manager left running ticks on the production
// cadence against those sessions, long after its test returned, so a package
// run that outlasts one cadence crashes in whichever session the tick reaches
// first. Managers in this binary start with a cadence no run reaches; a test
// that exercises the heartbeat sets its own with SetHeartbeatInterval.

import (
	"os"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/testhome"
)

// parkedHeartbeatInterval is longer than any run of this package.
const parkedHeartbeatInterval = 24 * time.Hour

func TestMain(m *testing.M) {
	initialHeartbeatInterval = parkedHeartbeatInterval
	// "ionh-" stays short: this HOME is the base for the CLI tool server's
	// Unix socket, which must fit the socket path limit.
	os.Exit(testhome.Run(m, "ionh-"))
}
