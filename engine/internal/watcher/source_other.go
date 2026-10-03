//go:build !windows

package watcher

import "github.com/fsnotify/fsnotify"

// fsnotifySource reports one directory per Add, so the Watcher attaches every
// directory of the tree itself.
type fsnotifySource struct {
	w *fsnotify.Watcher
}

func newEventSource(_ string) (eventSource, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &fsnotifySource{w: w}, nil
}

func (s *fsnotifySource) Add(dir string) error          { return s.w.Add(dir) }
func (s *fsnotifySource) Events() <-chan fsnotify.Event { return s.w.Events }
func (s *fsnotifySource) Errors() <-chan error          { return s.w.Errors }
func (s *fsnotifySource) Close() error                  { return s.w.Close() }
