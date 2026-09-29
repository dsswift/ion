//go:build e2e

package e2e

import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/testhome"
)

// TestMain points ION_DATA_DIR at a temp dir so the live tests here never
// write conversations into the real ~/.ion of whoever runs them. HOME stays
// real: the delegated-CLI tests need the operator's CLI sign-in.
func TestMain(m *testing.M) {
	os.Exit(testhome.RunDataDir(m, "ione-"))
}
