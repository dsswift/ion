package session

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/watcher"
)

// watcherPool deduplicates filesystem watchers across sessions that share
// the same working directory and ignore configuration. Without dedup,
// N sessions watching the same repo tree hold N watchers, each with its own
// kernel resources (one inotify watch per directory on Linux) and its own
// copy of every event.
//
// The pool is keyed by (root, ignores-hash, rename settings). Sessions
// that resolve to the same key share one watcher.Watcher and receive events
// via fan-out. The pool is refcounted: the underlying watcher closes when the
// last session releases its handle.
//
// A watcher starts on its own goroutine. Its startup walks the tree, and on a
// large root (a home directory) that takes longer than a client waits for a
// session to start, so acquire never waits on it: the entry is subscribable
// at once and ready closes when the start has finished either way.
type watcherPool struct {
	mu      sync.Mutex
	entries map[string]*poolEntry
}

type poolEntry struct {
	w           *watcher.Watcher
	refCount    int
	subscribers map[string]func(watcher.Info) // keyed by session key
	subMu       sync.RWMutex
	// ready closes once the watcher's start has finished, succeeded or not.
	// startErr holds the failure and is set before ready closes.
	ready    chan struct{}
	startErr error
	// closeOnce guards the entry's teardown, which both a failed start and
	// the last release may run.
	closeOnce sync.Once
}

// watcherStart starts a pooled watcher. A package var so a test can hold a
// start open and prove acquire does not wait on it. Production code never
// reassigns it.
var watcherStart = func(w *watcher.Watcher, onEvent func(watcher.Info)) error {
	return w.Start(context.Background(), onEvent)
}

// close tears the entry's watcher down, once.
func (e *poolEntry) close() {
	e.closeOnce.Do(func() {
		if err := e.w.Close(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "watcherpool: close failed", map[string]any{"error": err})
		}
	})
}

// fanOutEvent delivers a filesystem event, renames included, to every
// subscriber in the order the watcher observed them.
func (e *poolEntry) fanOutEvent(info watcher.Info) {
	e.subMu.RLock()
	defer e.subMu.RUnlock()
	for _, onEvent := range e.subscribers {
		onEvent(info)
	}
}

func newWatcherPool() *watcherPool {
	return &watcherPool{
		entries: make(map[string]*poolEntry),
	}
}

// poolKey builds a deterministic key from the root directory, the ignore
// patterns, and the rename settings. Sorted ignores ensure different
// orderings map to the same entry. The settings are part of the key because a
// watcher built without rename tracking cannot serve a session that needs it.
func poolKey(root string, ignores []string, renames renameSettings) string {
	sorted := make([]string, len(ignores))
	copy(sorted, ignores)
	sort.Strings(sorted)
	h := sha256.Sum256([]byte(strings.Join(sorted, "\x00") + "\x01" + renames.fingerprint()))
	return fmt.Sprintf("%s::%x", root, h[:8])
}

// acquire returns a shared watcher for the given root+ignores, creating one
// if this is the first subscriber. The sessionKey identifies the subscriber
// for fan-out and later release. maxDirs caps the directory count of a
// newly-created watcher (zero = watcher package default); it is only
// consulted when this acquire creates the watcher, since shared watchers keep
// the cap they were created with. renames decides whether the watcher tracks
// renames and which files it tracks.
//
// Returns a release function the caller must invoke when the session stops,
// and a channel that closes once the watcher has started (or failed to). The
// release function is idempotent and may run before the start has finished:
// the start then ends early and the watcher never runs.
func (p *watcherPool) acquire(root string, ignores []string, sessionKey string, maxDirs int, renames renameSettings, onEvent func(watcher.Info)) (release func(), ready <-chan struct{}, err error) {
	key := poolKey(root, ignores, renames)

	p.mu.Lock()
	entry, exists := p.entries[key]
	if exists {
		entry.subMu.Lock()
		entry.subscribers[sessionKey] = onEvent
		entry.refCount++
		refCount := entry.refCount
		entry.subMu.Unlock()
		p.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.acquire: shared", map[string]any{"key": key, "session_key": sessionKey, "ref_count": refCount, "root": root})
		return p.releaseFunc(key, sessionKey), entry.ready, nil
	}

	// First subscriber: create the watcher and start it in the background.
	// Rename tracking is requested only when enabled, so a disabled
	// subsystem leaves the watcher holding no per-file state.
	opts := watcher.Options{MaxDirs: maxDirs}
	if renames.enabled {
		opts.TrackRenames = renames.tracks
	}
	w, err := watcher.NewWithOptions(root, ignores, opts)
	if err != nil {
		p.mu.Unlock()
		return nil, nil, err
	}

	entry = &poolEntry{
		w:           w,
		refCount:    1,
		subscribers: map[string]func(watcher.Info){sessionKey: onEvent},
		ready:       make(chan struct{}),
	}
	p.entries[key] = entry
	p.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.acquire: created, starting in background", map[string]any{
		"key": key, "session_key": sessionKey, "root": root, "track_renames": renames.enabled,
	})
	go p.startEntry(key, entry, root)
	return p.releaseFunc(key, sessionKey), entry.ready, nil
}

// startEntry runs a new entry's watcher start and closes ready when it is
// done. A failed start drops the entry so the next acquire builds a fresh
// one; a start the last release ended early is not a failure.
func (p *watcherPool) startEntry(key string, entry *poolEntry, root string) {
	began := time.Now()
	err := watcherStart(entry.w, entry.fanOutEvent)
	entry.startErr = err
	if err == nil {
		utils.LogWithFields(utils.LevelInfo, "session", "watcherpool: watcher started", map[string]any{"key": key, "root": root, "duration_ms": time.Since(began).Milliseconds()})
		close(entry.ready)
		return
	}
	if errors.Is(err, watcher.ErrClosedDuringStart) {
		utils.LogWithFields(utils.LevelInfo, "session", "watcherpool: released before start finished", map[string]any{"key": key, "root": root, "duration_ms": time.Since(began).Milliseconds()})
	} else {
		utils.LogWithFields(utils.LevelError, "session", "watcherpool: watcher start failed", map[string]any{"key": key, "root": root, "error": err.Error(), "duration_ms": time.Since(began).Milliseconds()})
	}
	p.mu.Lock()
	if p.entries[key] == entry {
		delete(p.entries, key)
	}
	p.mu.Unlock()
	entry.close()
	close(entry.ready)
}

// releaseFunc returns an idempotent function that removes a subscriber and
// closes the watcher when the last subscriber leaves.
func (p *watcherPool) releaseFunc(key, sessionKey string) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()

			entry, exists := p.entries[key]
			if !exists {
				utils.LogWithFields(utils.LevelDebug, "session", "watcherpool.release: entry gone", map[string]any{"key": key, "session_key": sessionKey})
				return
			}

			entry.subMu.Lock()
			delete(entry.subscribers, sessionKey)
			entry.refCount--
			remaining := entry.refCount
			entry.subMu.Unlock()

			utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.release", map[string]any{"session_key": sessionKey, "key": key, "remaining": remaining})

			if remaining <= 0 {
				delete(p.entries, key)
				entry.close()
				utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.release: watcher closed", map[string]any{"key": key})
			}
		})
	}
}
