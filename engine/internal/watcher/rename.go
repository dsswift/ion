package watcher

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// renameWindow is how long a removed or newly created file waits for its
// counterpart before the two are treated as unrelated. The events of one
// rename arrive together; the window only has to outlast a directory move,
// whose files surface one at a time as the new directory is walked.
const renameWindow = 2 * time.Second

// fileIdentity is what stays the same when a file is renamed: the file
// itself, its size, and its modification time. All three must match. The file
// alone is not enough, because a filesystem can hand a deleted file's slot to
// the next file created.
type fileIdentity struct {
	info os.FileInfo
}

// identityKey is the comparable part of an identity, used to index it.
type identityKey struct {
	size    int64
	modTime int64
}

func newFileIdentity(info os.FileInfo) fileIdentity {
	// Comparing a FileInfo with itself makes the platform load the file's
	// identifier now, while the file still exists. On platforms that load it
	// lazily a later comparison would otherwise have to open a path that is
	// gone by then.
	os.SameFile(info, info)
	return fileIdentity{info: info}
}

func (id fileIdentity) key() identityKey {
	return identityKey{size: id.info.Size(), modTime: id.info.ModTime().UnixNano()}
}

func (id fileIdentity) same(other fileIdentity) bool {
	return id.key() == other.key() && os.SameFile(id.info, other.info)
}

// displaced is one side of a possible rename, waiting for the other.
type displaced struct {
	path, rel string
	id        fileIdentity
	at        time.Time
}

// renamePair is a correlated rename.
type renamePair struct {
	oldPath, oldRel string
	newPath, newRel string
}

// renameTracker remembers the identity of every tracked file so that a
// removal and a creation describing the same file can be reported as one
// rename. It holds nothing for files the track predicate rejects.
type renameTracker struct {
	track func(rel string) bool
	now   func() time.Time

	mu     sync.Mutex
	byPath map[string]fileIdentity
	gone   map[identityKey][]displaced
	born   map[identityKey][]displaced
	// resync is the pending rebuild of byPath after dropped events.
	resync *time.Timer
}

func newRenameTracker(track func(rel string) bool) *renameTracker {
	return &renameTracker{
		track:  track,
		now:    time.Now,
		byPath: make(map[string]fileIdentity),
		gone:   make(map[identityKey][]displaced),
		born:   make(map[identityKey][]displaced),
	}
}

// tracks reports whether rel is a file this tracker follows.
func (t *renameTracker) tracks(rel string) bool {
	return t.track(rel)
}

// seed records a file that already existed when watching began.
func (t *renameTracker) seed(path string, info os.FileInfo) {
	if !info.Mode().IsRegular() {
		return
	}
	id := newFileIdentity(info)
	t.mu.Lock()
	t.byPath[path] = id
	t.mu.Unlock()
}

// created records a file that appeared at path. It returns the rename when
// the file is one that was just removed from another path.
func (t *renameTracker) created(path, rel string, info os.FileInfo) (renamePair, bool) {
	if !info.Mode().IsRegular() {
		return renamePair{}, false
	}
	id := newFileIdentity(info)
	t.mu.Lock()
	defer t.mu.Unlock()
	t.prune()
	t.byPath[path] = id
	if old, ok := take(t.gone, id, path); ok {
		return renamePair{oldPath: old.path, oldRel: old.rel, newPath: path, newRel: rel}, true
	}
	key := id.key()
	t.born[key] = append(t.born[key], displaced{path: path, rel: rel, id: id, at: t.now()})
	return renamePair{}, false
}

// modified refreshes the identity of a file whose content changed.
func (t *renameTracker) modified(path string, info os.FileInfo) {
	if !info.Mode().IsRegular() {
		return
	}
	id := newFileIdentity(info)
	t.mu.Lock()
	t.byPath[path] = id
	t.mu.Unlock()
}

// removed records that path is gone. path may be a tracked file or a
// directory holding tracked files; every tracked file under it is treated as
// removed. It returns the renames whose creation was already seen.
func (t *renameTracker) removed(path string, relOf func(string) string) []renamePair {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.prune()

	var pairs []renamePair
	settle := func(p string, id fileIdentity) {
		delete(t.byPath, p)
		rel := relOf(p)
		if fresh, ok := take(t.born, id, p); ok {
			pairs = append(pairs, renamePair{oldPath: p, oldRel: rel, newPath: fresh.path, newRel: fresh.rel})
			return
		}
		key := id.key()
		t.gone[key] = append(t.gone[key], displaced{path: p, rel: rel, id: id, at: t.now()})
	}

	if id, ok := t.byPath[path]; ok {
		settle(path, id)
		return pairs
	}
	prefix := path + string(filepath.Separator)
	for p, id := range t.byPath {
		if strings.HasPrefix(p, prefix) {
			settle(p, id)
		}
	}
	return pairs
}

// take removes and returns the waiting entry that is the same file as id and
// sits at a different path.
func take(waiting map[identityKey][]displaced, id fileIdentity, path string) (displaced, bool) {
	key := id.key()
	entries := waiting[key]
	for i, e := range entries {
		if e.path == path || !e.id.same(id) {
			continue
		}
		if len(entries) == 1 {
			delete(waiting, key)
		} else {
			waiting[key] = append(entries[:i:i], entries[i+1:]...)
		}
		return e, true
	}
	return displaced{}, false
}

// prune drops waiting entries older than renameWindow. Caller holds mu.
func (t *renameTracker) prune() {
	cutoff := t.now().Add(-renameWindow)
	for _, waiting := range []map[identityKey][]displaced{t.gone, t.born} {
		for key, entries := range waiting {
			kept := entries[:0]
			for _, e := range entries {
				if e.at.After(cutoff) {
					kept = append(kept, e)
				}
			}
			if len(kept) == 0 {
				delete(waiting, key)
			} else {
				waiting[key] = kept
			}
		}
	}
}

// observe feeds one filesystem event to the tracker and delivers any rename
// it completes. Called from the event pump before the event is debounced, so
// a file's identity is read as close to the event as possible.
func (w *Watcher) observe(path, rel, action string) {
	t := w.renames
	if t == nil {
		return
	}
	switch action {
	case ActionDelete:
		for _, pair := range t.removed(path, w.rel) {
			w.deliverRename(pair)
		}
	case ActionCreate, ActionModify:
		if !t.tracks(rel) {
			return
		}
		info, err := os.Lstat(path)
		if err != nil {
			utils.LogWithFields(utils.LevelDebug, "watcher", "rename tracking stat failed", map[string]any{"path": path, "error": err.Error()})
			return
		}
		if action == ActionModify {
			t.modified(path, info)
			return
		}
		if pair, ok := t.created(path, rel, info); ok {
			w.deliverRename(pair)
		}
	}
}

// deliverRename fires the callback for a correlated rename. The rename is
// delivered as soon as both sides are known, independent of the debounced
// delete and create that still follow for the two paths.
func (w *Watcher) deliverRename(pair renamePair) {
	w.mu.Lock()
	cb := w.onEvent
	closed := w.closed
	w.mu.Unlock()
	if closed || cb == nil {
		utils.LogWithFields(utils.LevelDebug, "watcher", "rename dropped post-close", map[string]any{"path": pair.newPath})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "watcher", "rename correlated", map[string]any{"old": pair.oldRel, "new": pair.newRel})
	cb(Info{
		Path:       pair.newPath,
		RelPath:    pair.newRel,
		Action:     ActionRename,
		OldPath:    pair.oldPath,
		OldRelPath: pair.oldRel,
	})
}

// resyncDelay is how long the tracker waits after the last report of dropped
// events before it rebuilds. Drops arrive in bursts while the tree is still
// changing; one rebuild after the burst replaces many during it.
const resyncDelay = 500 * time.Millisecond

// scheduleRenameResync queues a rebuild of the rename tracker's file
// identities. Called when the event source dropped changes: files created,
// removed, or rewritten in the gap would otherwise keep a stale identity, or
// none, and a later rename of one would go uncorrelated.
func (w *Watcher) scheduleRenameResync() {
	t := w.renames
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.resync != nil {
		t.resync.Reset(resyncDelay)
		return
	}
	t.resync = time.AfterFunc(resyncDelay, w.resyncRenames)
}

// resyncRenames walks the tree and replaces the tracker's file identities
// with what is on disk now.
func (w *Watcher) resyncRenames() {
	t := w.renames
	t.mu.Lock()
	t.resync = nil
	t.mu.Unlock()

	w.mu.Lock()
	closed := w.closed
	w.mu.Unlock()
	if closed {
		return
	}

	fresh := make(map[string]fileIdentity)
	filepath.Walk(w.root, func(path string, info os.FileInfo, err error) error { //nolint:errcheck // walk errors handled per-entry
		if err != nil || info == nil {
			return nil
		}
		rel := w.rel(path)
		if info.IsDir() {
			if w.shouldIgnore(rel, true) {
				return filepath.SkipDir
			}
			return nil
		}
		if info.Mode().IsRegular() && t.tracks(rel) && !w.shouldIgnore(rel, false) {
			fresh[path] = newFileIdentity(info)
		}
		return nil
	})

	t.mu.Lock()
	t.byPath = fresh
	t.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "watcher", "rename tracking resynced after dropped events", map[string]any{"path": w.root, "count": len(fresh)})
}

// stopResync cancels a pending rebuild.
func (t *renameTracker) stopResync() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.resync != nil {
		t.resync.Stop()
		t.resync = nil
	}
}
