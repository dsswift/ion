//go:build darwin && cgo

package watcher

// newEventSource builds the source for a watcher root. macOS uses one
// FSEvents stream per root: fsnotify's kqueue backend there holds an open
// descriptor for every file in every watched directory, so a large tree
// exhausts the process descriptor table.
var newEventSource = newFSEventsSource
