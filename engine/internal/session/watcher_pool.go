package session

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/watcher"
)

// watcherPool deduplicates filesystem watchers across sessions that share
// the same working directory and ignore configuration. Without dedup,
// N sessions watching the same repo tree hold N watchers, each with its own
// kernel resources (one inotify watch per directory on Linux) and its own
// copy of every event.
//
// The pool is keyed by (root, ignores-hash, wiki-link settings). Sessions
// that resolve to the same key share one watcher.Watcher and receive events
// via fan-out. The pool is refcounted: the underlying watcher closes when the
// last session releases its handle.
//
// Work that must happen once per workspace rather than once per session lives
// on the entry: a rename rewrites wiki links a single time, and the resulting
// report is then fanned out to every subscribed session.
//
// Renames leave the watcher's event goroutine at once. They are handed to the
// entry's renameWorker, which notifies subscribers and rewrites links on its
// own goroutine, so a slow subscriber never stalls filesystem events.
type watcherPool struct {
	mu      sync.Mutex
	entries map[string]*poolEntry
}

// watchSubscriber is one session's share of a pooled watcher.
type watchSubscriber struct {
	// onEvent receives every filesystem event, renames included. Renames
	// arrive in the order they were observed.
	onEvent func(watcher.Info)
	// onPropagated receives the report of each wiki-link propagation pass.
	onPropagated func(types.WikiLinkPropagationReport)
}

type poolEntry struct {
	w           *watcher.Watcher
	refCount    int
	subscribers map[string]watchSubscriber // keyed by session key
	subMu       sync.RWMutex
	// renames handles the renames this entry's watcher reports. Nil when the
	// watcher tracks none.
	renames *renameWorker
}

// handleEvent is the watcher callback: a rename is queued for the rename
// worker, anything else is delivered to every subscriber directly.
func (e *poolEntry) handleEvent(info watcher.Info) {
	if info.Action == watcher.ActionRename {
		if e.renames != nil {
			e.renames.enqueue(info)
		}
		return
	}
	e.fanOutEvent(info)
}

// fanOutEvent delivers a filesystem event to every subscriber.
func (e *poolEntry) fanOutEvent(info watcher.Info) {
	e.subMu.RLock()
	defer e.subMu.RUnlock()
	for _, sub := range e.subscribers {
		sub.onEvent(info)
	}
}

// fanOutReport delivers a propagation report to every subscriber.
func (e *poolEntry) fanOutReport(report types.WikiLinkPropagationReport) {
	e.subMu.RLock()
	defer e.subMu.RUnlock()
	for _, sub := range e.subscribers {
		if sub.onPropagated != nil {
			sub.onPropagated(report)
		}
	}
}

func newWatcherPool() *watcherPool {
	return &watcherPool{
		entries: make(map[string]*poolEntry),
	}
}

// poolKey builds a deterministic key from the root directory, the ignore
// patterns, and the wiki-link settings. Sorted ignores ensure different
// orderings map to the same entry. The settings are part of the key because a
// watcher built without rename tracking cannot serve a session that needs it.
func poolKey(root string, ignores []string, links wikiLinkSettings) string {
	sorted := make([]string, len(ignores))
	copy(sorted, ignores)
	sort.Strings(sorted)
	h := sha256.Sum256([]byte(strings.Join(sorted, "\x00") + "\x01" + links.fingerprint()))
	return fmt.Sprintf("%s::%x", root, h[:8])
}

// acquire returns a shared watcher for the given root+ignores, creating one
// if this is the first subscriber. The sessionKey identifies the subscriber
// for fan-out and later release. maxDirs caps the directory count of a
// newly-created watcher (zero = watcher package default); it is only
// consulted when this acquire creates the watcher, since shared watchers keep
// the cap they were created with. links decides whether the watcher tracks
// renames and whether a rename rewrites wiki links.
//
// Returns a release function the caller must invoke when the session stops.
// The release function is idempotent.
func (p *watcherPool) acquire(root string, ignores []string, sessionKey string, maxDirs int, links wikiLinkSettings, sub watchSubscriber) (release func(), err error) {
	key := poolKey(root, ignores, links)

	p.mu.Lock()
	defer p.mu.Unlock()

	entry, exists := p.entries[key]
	if exists {
		entry.subMu.Lock()
		entry.subscribers[sessionKey] = sub
		entry.refCount++
		entry.subMu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.acquire: shared", map[string]any{"key": key, "session_key": sessionKey, "ref_count": entry.refCount, "root": root})
		return p.releaseFunc(key, sessionKey), nil
	}

	// First subscriber: create and start the watcher. Rename tracking is
	// requested only when wiki links are enabled, so a disabled subsystem
	// leaves the watcher holding no per-file state.
	opts := watcher.Options{MaxDirs: maxDirs}
	if links.enabled {
		opts.TrackRenames = links.isDocument
	}
	w, err := watcher.NewWithOptions(root, ignores, opts)
	if err != nil {
		return nil, err
	}

	entry = &poolEntry{
		w:           w,
		refCount:    1,
		subscribers: map[string]watchSubscriber{sessionKey: sub},
	}
	if links.enabled {
		entry.renames = newRenameWorker(links.options(root, ignores), links.propagate, entry.fanOutEvent, entry.fanOutReport)
	}
	p.entries[key] = entry

	if err := w.Start(context.Background(), entry.handleEvent); err != nil {
		w.Close() //nolint:errcheck // resource close
		if entry.renames != nil {
			entry.renames.close()
		}
		delete(p.entries, key)
		return nil, err
	}

	utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.acquire: created", map[string]any{
		"key": key, "session_key": sessionKey, "root": root, "track_renames": links.enabled, "propagate_links": links.propagate,
	})
	return p.releaseFunc(key, sessionKey), nil
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
				if err := entry.w.Close(); err != nil {
					utils.LogWithFields(utils.LevelError, "session", "watcherpool.release: close failed", map[string]any{"key": key, "error": err})
				}
				if entry.renames != nil {
					entry.renames.close()
				}
				utils.LogWithFields(utils.LevelInfo, "session", "watcherpool.release: watcher closed", map[string]any{"key": key})
			}
		})
	}
}
