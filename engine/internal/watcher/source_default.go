//go:build !windows && (!darwin || !cgo)

package watcher

import (
	"runtime"

	"github.com/dsswift/ion/engine/internal/utils"
)

// newEventSource builds the source for a watcher root. Without FSEvents the
// per-directory source is the only one available.
var newEventSource = func(root string) (eventSource, error) {
	if runtime.GOOS == "darwin" {
		// A darwin build without cgo has no FSEvents. fsnotify's kqueue
		// backend holds a descriptor for every file in every watched
		// directory, so a large tree can exhaust the process.
		utils.LogWithFields(utils.LevelWarn, "watcher", "fsevents unavailable in a build without cgo, using kqueue", map[string]any{"path": root})
	}
	return newDirectorySource(root)
}
