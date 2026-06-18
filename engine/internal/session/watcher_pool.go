package session

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/watcher"
)

// watcherPool deduplicates filesystem watchers across sessions that share
// the same working directory and ignore configuration. Without dedup,
// N sessions watching the same repo tree consume N * dirs file descriptors
// (kqueue on macOS requires one FD per watched directory). Ten sessions on
// a ~6000-directory tree exhaust the default 10240 soft limit and even the
// 61440 hard limit, causing DNS lookups and socket operations to fail with
// EMFILE / "no such host."
//
// The pool is keyed by (root, ignores-hash). Sessions that resolve to the
// same key share one watcher.Watcher and receive events via fan-out. The
// pool is refcounted: the underlying watcher closes when the last session
// releases its handle.
type watcherPool struct {
	mu      sync.Mutex
	entries map[string]*poolEntry
}

type poolEntry struct {
	w           *watcher.Watcher
	refCount    int
	subscribers map[string]func(watcher.Info) // keyed by session key
	subMu       sync.RWMutex
}

func newWatcherPool() *watcherPool {
	return &watcherPool{
		entries: make(map[string]*poolEntry),
	}
}

// poolKey builds a deterministic key from the root directory and ignore
// patterns. Sorted ignores ensure different orderings map to the same entry.
func poolKey(root string, ignores []string) string {
	sorted := make([]string, len(ignores))
	copy(sorted, ignores)
	sort.Strings(sorted)
	h := sha256.Sum256([]byte(strings.Join(sorted, "\x00")))
	return fmt.Sprintf("%s::%x", root, h[:8])
}

// acquire returns a shared watcher for the given root+ignores, creating one
// if this is the first subscriber. The sessionKey identifies the subscriber
// for fan-out and later release. onEvent is the per-session callback. maxDirs
// caps the directory count of a newly-created watcher (zero = watcher package
// default); it is only consulted when this acquire creates the watcher, since
// shared watchers keep the cap they were created with.
//
// Returns a release function the caller must invoke when the session stops.
// The release function is idempotent.
func (p *watcherPool) acquire(root string, ignores []string, sessionKey string, maxDirs int, onEvent func(watcher.Info)) (release func(), err error) {
	key := poolKey(root, ignores)

	p.mu.Lock()
	defer p.mu.Unlock()

	entry, exists := p.entries[key]
	if exists {
		entry.subMu.Lock()
		entry.subscribers[sessionKey] = onEvent
		entry.refCount++
		entry.subMu.Unlock()
		utils.Info("session", fmt.Sprintf("watcherPool.acquire: shared key=%s session=%s refcount=%d root=%s", key, sessionKey, entry.refCount, root))
		return p.releaseFunc(key, sessionKey), nil
	}

	// First subscriber: create and start the watcher.
	w, err := watcher.NewWithMaxDirs(root, ignores, maxDirs)
	if err != nil {
		return nil, err
	}

	entry = &poolEntry{
		w:        w,
		refCount: 1,
		subscribers: map[string]func(watcher.Info){
			sessionKey: onEvent,
		},
	}
	p.entries[key] = entry

	// The fan-out callback dispatches to all current subscribers.
	fanOut := func(info watcher.Info) {
		entry.subMu.RLock()
		defer entry.subMu.RUnlock()
		for _, cb := range entry.subscribers {
			cb(info)
		}
	}

	if err := w.Start(context.Background(), fanOut); err != nil {
		_ = w.Close()
		delete(p.entries, key)
		return nil, err
	}

	utils.Info("session", fmt.Sprintf("watcherPool.acquire: created key=%s session=%s root=%s", key, sessionKey, root))
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
				utils.Debug("session", fmt.Sprintf("watcherPool.release: entry gone key=%s session=%s", key, sessionKey))
				return
			}

			entry.subMu.Lock()
			delete(entry.subscribers, sessionKey)
			entry.refCount--
			remaining := entry.refCount
			entry.subMu.Unlock()

			utils.Info("session", fmt.Sprintf("watcherPool.release: session=%s key=%s remaining=%d", sessionKey, key, remaining))

			if remaining <= 0 {
				delete(p.entries, key)
				if err := entry.w.Close(); err != nil {
					utils.Error("session", fmt.Sprintf("watcherPool.release: close failed key=%s err=%v", key, err))
				}
				utils.Info("session", fmt.Sprintf("watcherPool.release: watcher closed key=%s", key))
			}
		})
	}
}
