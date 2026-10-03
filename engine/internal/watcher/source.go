package watcher

import "github.com/fsnotify/fsnotify"

// eventSource is the platform mechanism that reports filesystem changes under
// a watcher's root. Every source reports in fsnotify's event shape so the
// pump, ignore filter, debouncer, and rename tracker are shared.
//
// Sources come in two kinds, reported by Recursive:
//   - A recursive source covers the whole tree from one subscription on the
//     root. Its cost does not grow with the tree, so the directory cap does
//     not apply to it.
//   - A per-directory source needs Add for every directory and holds one
//     kernel resource per added directory (an inotify watch, or a kqueue
//     descriptor for the directory plus one for every file in it). The walk
//     attaches each directory and enforces the cap.
type eventSource interface {
	// Add subscribes one directory. A recursive source is subscribed to the
	// root at construction and Add is never called on it.
	Add(dir string) error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
	// Recursive reports whether the source covers the whole tree from its
	// root subscription.
	Recursive() bool
	Close() error
}

// directorySource is the per-directory source backed by fsnotify: inotify on
// Linux, and kqueue on a macOS build without cgo. Tests use it on every
// platform to exercise the directory cap.
type directorySource struct {
	fsw *fsnotify.Watcher
}

func newDirectorySource(string) (eventSource, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &directorySource{fsw: fsw}, nil
}

func (s *directorySource) Add(dir string) error          { return s.fsw.Add(dir) }
func (s *directorySource) Events() <-chan fsnotify.Event { return s.fsw.Events }
func (s *directorySource) Errors() <-chan error          { return s.fsw.Errors }
func (s *directorySource) Recursive() bool               { return false }
func (s *directorySource) Close() error                  { return s.fsw.Close() }
