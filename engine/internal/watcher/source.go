package watcher

import "github.com/fsnotify/fsnotify"

// eventSource is the OS change feed a Watcher consumes. Add asks the source to
// report changes inside one directory; the source delivers them on Events.
type eventSource interface {
	Add(dir string) error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
	Close() error
}
