//go:build !windows

package filetail

import "os"

// openShared opens path for reading. POSIX rename/unlink never needs the
// target's cooperation, so there is no share-mode concern to work around
// here; os.Open is already exactly this. See open_windows.go's doc comment
// for why Windows needs a different implementation.
func openShared(path string) (*os.File, error) {
	return os.Open(path)
}
