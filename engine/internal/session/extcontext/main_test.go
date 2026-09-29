package extcontext

import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/testhome"
)

// TestMain gives this package's test binary a temp HOME and a cleared
// ION_DATA_DIR. Tests here run backend loops, sessions, and dispatches that
// persist conversations to the default store; without this they write into
// the real ~/.ion/conversations of whoever runs the tests.
func TestMain(m *testing.M) {
	os.Exit(testhome.Run(m, "ionx-"))
}
