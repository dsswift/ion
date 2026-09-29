// Tiny helpers used by async_lifecycle.go that have nowhere natural
// to live. Kept in a separate file so async_lifecycle.go focuses on
// the wiring logic.

package session

import (
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// millisToDuration converts a millisecond count to a time.Duration.
// Trivial but pulled out so the calling translation funcs don't have
// to import time directly.
func millisToDuration(ms int64) time.Duration {
	return time.Duration(ms) * time.Millisecond
}

// defaultSchedulerPersistDir returns the directory used to persist scheduler
// last-run markers. When ION_DATA_DIR is set in the environment it is used as
// the base so that multiple engine instances on the same machine use separate
// scheduler directories without silent cross-process last-run file conflicts
// (#191). When unset the conventional ~/.ion/scheduler path is returned. When
// the home directory is unresolvable, returns "" — persistence becomes a no-op
// and the scheduler degrades to in-process catch-up only.
func defaultSchedulerPersistDir() string {
	dir := utils.IonDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "scheduler")
}
