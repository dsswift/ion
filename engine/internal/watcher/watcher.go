// Package watcher implements a recursive filesystem watcher rooted at a
// session's working directory. It fires a callback for every create / modify /
// delete event under the root, coalescing rapid duplicate events on the same
// path through a short debounce window so that editor save patterns (vim swap
// + rename, JetBrains temp-file + rename, multi-event saves) collapse to a
// single notification.
//
// The watcher is consumed by the session manager and broadcast to extensions
// via the `workspace_file_changed` hook. It is the engine-owned counterpart to
// the LLM-only `file_changed` hook: this fires on external edits, that one
// fires on LLM Write / Edit tool calls.
//
// Recursive watching is implemented manually by walking the tree at startup
// and dynamically attaching / detaching on directory create / remove events.
// fsnotify is non-recursive on Linux and Windows; doing it ourselves yields
// consistent semantics across macOS / Linux / Windows and lets us apply the
// ignore-glob list at the directory level (so we never attach inotify
// descriptors to ignored subtrees like node_modules).
package watcher

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/fsnotify/fsnotify"
)

// debounceWindow is the quiet period after a path's last event before the
// coalesced event is delivered. Picked at 50 ms: long enough to collapse the
// 2-4 events VS Code / vim / JetBrains fire on a single Cmd+S; short enough
// that the user-perceived latency between save and hook fire stays well under
// one frame.
const debounceWindow = 50 * time.Millisecond

// Action enumerates the normalized event kinds delivered to the callback.
// Rename is deliberately absent: cross-editor rename detection is unreliable
// (vim writes via .swp + rename, JetBrains writes via temp + rename, atomic
// replaces look like delete+create from inotify's perspective). We emit the
// raw delete + create pair and let consumers decide whether they care.
const (
	ActionCreate = "create"
	ActionModify = "modify"
	ActionDelete = "delete"
)

// Info is the payload delivered to the OnEvent callback. RelPath is always
// forward-slash separated (even on Windows) so glob patterns and string
// comparisons work portably; Path is the absolute OS-native path.
type Info struct {
	Path    string
	RelPath string
	Action  string
}

// Watcher recursively watches a root directory and invokes OnEvent for every
// create / modify / delete under the tree (excluding paths matched by the
// ignore globs).
//
// Lifecycle: New() validates the root and compiles the ignore patterns;
// Start() walks the tree, attaches fsnotify, and spawns the event-pump
// goroutine; Close() stops the goroutine and tears down fsnotify. Start may
// be called at most once per Watcher.
type Watcher struct {
	root    string
	ignores []string

	mu       sync.Mutex
	fsw      *fsnotify.Watcher
	cancel   context.CancelFunc
	pending  map[string]*pendingEvent
	pendMu   sync.Mutex
	started  bool
	closed   bool
	onEvent  func(Info)
	doneCh   chan struct{}
}

// pendingEvent tracks an in-flight debounced event. action is the latest
// observed kind for the path (create / modify / delete); timer fires after
// debounceWindow if no further event arrives.
type pendingEvent struct {
	action string
	timer  *time.Timer
}

// New constructs a Watcher rooted at the given absolute directory. ignores is
// a list of doublestar glob patterns matched against repo-relative,
// forward-slash paths (e.g. "node_modules/**", ".git/**"). An empty ignores
// slice means "watch everything." The root must exist and be a directory.
//
// New does NOT attach any inotify descriptors -- call Start() to begin
// watching.
func New(root string, ignores []string) (*Watcher, error) {
	if root == "" {
		return nil, errors.New("watcher: root is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		utils.Error("watcher", "New: filepath.Abs failed root="+root+" err="+err.Error())
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		utils.Error("watcher", "New: stat root failed root="+abs+" err="+err.Error())
		return nil, err
	}
	if !st.IsDir() {
		utils.Error("watcher", "New: root is not a directory root="+abs)
		return nil, errors.New("watcher: root is not a directory: " + abs)
	}
	// Validate every ignore pattern up front so a malformed glob surfaces at
	// session start, not on the first event.
	for _, pat := range ignores {
		if _, err := doublestar.Match(pat, ""); err != nil {
			utils.Error("watcher", "New: invalid ignore pattern pattern="+pat+" err="+err.Error())
			return nil, errors.New("watcher: invalid ignore pattern " + pat + ": " + err.Error())
		}
	}
	utils.Info("watcher", "New: constructed root="+abs+" ignores="+countStr(len(ignores)))
	utils.Info("watcher", "New: ignore patterns root="+abs+" patterns=["+strings.Join(ignores, ", ")+"]")
	return &Watcher{
		root:    abs,
		ignores: ignores,
		pending: make(map[string]*pendingEvent),
		doneCh:  make(chan struct{}),
	}, nil
}

// Start walks the tree under root, attaches an fsnotify watch to every
// non-ignored directory, and spawns the event-pump goroutine. onEvent is
// invoked from the pump goroutine after debounce -- callers must not block in
// the callback (forward to a channel / extension group if heavy work is
// needed). Start is idempotent on error: a partial walk that fails midway
// still closes the underlying fsnotify watcher before returning.
func (w *Watcher) Start(ctx context.Context, onEvent func(Info)) error {
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return errors.New("watcher: already started")
	}
	if w.closed {
		w.mu.Unlock()
		return errors.New("watcher: already closed")
	}
	if onEvent == nil {
		w.mu.Unlock()
		return errors.New("watcher: onEvent is nil")
	}

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		w.mu.Unlock()
		utils.Error("watcher", "Start: fsnotify.NewWatcher failed err="+err.Error())
		return err
	}
	w.fsw = fsw
	w.onEvent = onEvent
	pumpCtx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	w.started = true
	w.mu.Unlock()

	// Walk the tree and attach to every non-ignored directory. We tolerate
	// per-entry failures (a dir may be unreadable, deleted mid-walk, etc.)
	// because losing one subtree should not break the whole watcher.
	attached := 0
	walkErr := filepath.Walk(w.root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			utils.Debug("watcher", "Start: walk skip path="+path+" err="+err.Error())
			return nil
		}
		if !info.IsDir() {
			return nil
		}
		rel := w.rel(path)
		if w.shouldIgnore(rel, true) {
			utils.Debug("watcher", "Start: walk ignore dir rel="+rel)
			return filepath.SkipDir
		}
		if err := fsw.Add(path); err != nil {
			utils.Debug("watcher", "Start: fsw.Add failed path="+path+" err="+err.Error())
			return nil
		}
		attached++
		return nil
	})
	if walkErr != nil {
		// Walk itself only returns the root-stat error here; per-entry errors
		// are swallowed above. If we got nothing usable, bail out cleanly.
		utils.Error("watcher", "Start: walk failed err="+walkErr.Error())
		_ = fsw.Close()
		cancel()
		w.mu.Lock()
		w.started = false
		w.fsw = nil
		w.cancel = nil
		w.mu.Unlock()
		return walkErr
	}

	utils.Info("watcher", "Start: attached root="+w.root+" dirs="+countStr(attached))
	go w.pump(pumpCtx)
	return nil
}

// Close stops the pump, cancels any pending debounced events, and tears down
// fsnotify. Safe to call multiple times. Returns nil if the watcher was never
// started.
func (w *Watcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	cancel := w.cancel
	fsw := w.fsw
	started := w.started
	w.mu.Unlock()

	if !started {
		utils.Info("watcher", "Close: not started, nothing to do root="+w.root)
		return nil
	}
	if cancel != nil {
		cancel()
	}
	// Wait for the pump goroutine to exit before closing fsnotify; otherwise
	// the pump can race on a closed channel.
	<-w.doneCh

	if fsw != nil {
		if err := fsw.Close(); err != nil {
			utils.Error("watcher", "Close: fsnotify.Close failed err="+err.Error())
		}
	}

	// Drain any pending debounce timers so we don't leak goroutines.
	w.pendMu.Lock()
	for path, p := range w.pending {
		if p.timer != nil {
			p.timer.Stop()
		}
		delete(w.pending, path)
	}
	w.pendMu.Unlock()

	utils.Info("watcher", "Close: stopped root="+w.root)
	return nil
}

// pump runs in its own goroutine; consumes fsnotify events / errors and
// translates them to debounced Info callbacks.
func (w *Watcher) pump(ctx context.Context) {
	defer close(w.doneCh)
	utils.Debug("watcher", "pump: started root="+w.root)
	for {
		select {
		case <-ctx.Done():
			utils.Debug("watcher", "pump: ctx done, exiting root="+w.root)
			return
		case ev, ok := <-w.fsw.Events:
			if !ok {
				utils.Debug("watcher", "pump: events channel closed, exiting root="+w.root)
				return
			}
			w.handleEvent(ev)
		case err, ok := <-w.fsw.Errors:
			if !ok {
				utils.Debug("watcher", "pump: errors channel closed, exiting root="+w.root)
				return
			}
			utils.Error("watcher", "pump: fsnotify error err="+err.Error())
		}
	}
}

// handleEvent normalizes an fsnotify event and either drops it (ignored) or
// schedules a debounced delivery. On directory create we recursively attach;
// on directory delete fsnotify auto-detaches but we still emit the delete.
func (w *Watcher) handleEvent(ev fsnotify.Event) {
	path := ev.Name
	rel := w.rel(path)

	// Determine whether the path is a directory. For Remove/Rename the path is
	// gone, so we cannot stat; assume non-directory and let the ignore filter
	// see the path as a file. Created directories must be attached recursively
	// so we know about files born inside them.
	isDir := false
	if ev.Op&fsnotify.Create != 0 || ev.Op&fsnotify.Write != 0 || ev.Op&fsnotify.Chmod != 0 {
		if st, err := os.Stat(path); err == nil {
			isDir = st.IsDir()
		}
	}

	if w.shouldIgnore(rel, isDir) {
		utils.Debug("watcher", "handleEvent: ignored path="+path+" op="+ev.Op.String())
		return
	}

	// Map fsnotify ops to our action taxonomy. fsnotify can deliver
	// multi-bit ops (Create|Write) -- we pick the most semantically useful
	// single action and let the debouncer collapse the rest.
	var action string
	switch {
	case ev.Op&fsnotify.Create != 0:
		action = ActionCreate
		if isDir {
			// New directory: attach recursively so we catch files born inside
			// it. Errors here are non-fatal -- worst case we miss events under
			// the new subtree until the next session. skipRoot=true because
			// we're about to schedule the Create event for the new dir via
			// the normal pipeline below.
			w.attachSubtree(path, true)
		}
	case ev.Op&fsnotify.Remove != 0, ev.Op&fsnotify.Rename != 0:
		action = ActionDelete
	case ev.Op&fsnotify.Write != 0:
		action = ActionModify
	case ev.Op&fsnotify.Chmod != 0:
		// Chmod-only events are noisy and rarely interesting for hot-reload
		// use cases. Drop them.
		utils.Debug("watcher", "handleEvent: chmod-only, dropped path="+path)
		return
	default:
		utils.Debug("watcher", "handleEvent: unknown op, dropped path="+path+" op="+ev.Op.String())
		return
	}

	utils.Debug("watcher", "handleEvent: queue path="+path+" rel="+rel+" action="+action+" op="+ev.Op.String())
	w.schedule(path, rel, action)
}

// attachSubtree walks a newly-created directory, attaches fsnotify to every
// non-ignored descendant directory, and synthesizes Create events for files
// already present inside it. The synthesis is necessary because fsnotify on
// Linux/macOS races with filepath.Walk during fast MkdirAll-then-write
// sequences: by the time we add the new dir to fsnotify, its child entries
// may have been created without us seeing the events. Synthesizing from the
// walk closes that race for content present at attach time.
//
// The skipRoot argument suppresses an event for the dir whose Create event
// triggered this walk (we already emitted the Create event for it via the
// normal pipeline; emitting again would be a duplicate).
func (w *Watcher) attachSubtree(root string, skipRoot bool) {
	w.mu.Lock()
	fsw := w.fsw
	w.mu.Unlock()
	if fsw == nil {
		return
	}
	attached := 0
	synthesized := 0
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		rel := w.rel(path)
		if info.IsDir() {
			if w.shouldIgnore(rel, true) {
				return filepath.SkipDir
			}
			if err := fsw.Add(path); err != nil {
				utils.Debug("watcher", "attachSubtree: fsw.Add failed path="+path+" err="+err.Error())
				return nil
			}
			attached++
			if path == root && skipRoot {
				return nil
			}
			// Synthesize a Create for the directory itself so consumers see
			// nested dirs born during the race window.
			w.schedule(path, rel, ActionCreate)
			synthesized++
			return nil
		}
		// File: skip if ignored.
		if w.shouldIgnore(rel, false) {
			return nil
		}
		w.schedule(path, rel, ActionCreate)
		synthesized++
		return nil
	})
	utils.Debug("watcher", "attachSubtree: done root="+root+" dirs="+countStr(attached)+" synth="+countStr(synthesized))
}

// schedule queues a debounced delivery for path. If another event arrives on
// the same path within debounceWindow, the timer is reset and the action is
// updated to the latest observed value. Delete is sticky: once a path is
// scheduled for deletion, subsequent Create events on the same path within
// the window are NOT downgraded -- they bump the action back to Create
// because the path is alive again.
func (w *Watcher) schedule(path, rel, action string) {
	w.pendMu.Lock()
	defer w.pendMu.Unlock()

	if existing, ok := w.pending[path]; ok {
		existing.timer.Stop()
		// Last action wins -- this naturally handles atomic-replace patterns
		// (delete followed by create within ms) where the final state is
		// "the file exists with new contents," which we model as a single
		// Create or Modify event depending on what fsnotify reported last.
		existing.action = action
		existing.timer = time.AfterFunc(debounceWindow, w.deliverFunc(path, rel))
		return
	}
	w.pending[path] = &pendingEvent{
		action: action,
		timer:  time.AfterFunc(debounceWindow, w.deliverFunc(path, rel)),
	}
}

// deliverFunc returns a closure that pops the pending entry for path and
// fires the callback. We capture rel separately so we don't have to rebuild
// it from path inside the timer goroutine.
func (w *Watcher) deliverFunc(path, rel string) func() {
	return func() {
		w.pendMu.Lock()
		entry, ok := w.pending[path]
		if !ok {
			w.pendMu.Unlock()
			return
		}
		delete(w.pending, path)
		action := entry.action
		w.pendMu.Unlock()

		w.mu.Lock()
		cb := w.onEvent
		closed := w.closed
		w.mu.Unlock()
		if closed || cb == nil {
			utils.Debug("watcher", "deliverFunc: dropped post-close path="+path)
			return
		}
		utils.Info("watcher", "deliverFunc: fire path="+path+" rel="+rel+" action="+action)
		cb(Info{Path: path, RelPath: rel, Action: action})
	}
}

// rel returns the forward-slash path of `path` relative to the watcher root.
// Falls back to the absolute path when relpath fails (which should never
// happen for paths produced by fsnotify under our root, but better safe than
// confusing a hook handler).
func (w *Watcher) rel(path string) string {
	r, err := filepath.Rel(w.root, path)
	if err != nil {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(r)
}

// shouldIgnore reports whether a path matches any of the configured ignore
// globs. For directories we also check the "{pattern}/**" form so a pattern
// like "node_modules/**" matches the bare directory entry as well, letting
// the Walk SkipDir prune the subtree without emitting events for the dir
// itself.
func (w *Watcher) shouldIgnore(rel string, isDir bool) bool {
	if rel == "." || rel == "" {
		return false
	}
	for _, pat := range w.ignores {
		if match, _ := doublestar.Match(pat, rel); match {
			return true
		}
		if isDir {
			// "node_modules/**" should match the directory "node_modules"
			// itself for SkipDir purposes; doublestar.Match with the literal
			// directory name won't match the trailing /** form.
			if match, _ := doublestar.Match(pat, rel+"/x"); match {
				return true
			}
		}
	}
	return false
}

// countStr formats an integer count without pulling in strconv at every call
// site. Used for log message construction.
func countStr(n int) string {
	if n == 0 {
		return "0"
	}
	// Small fast path: ASCII decimal without allocation. Acceptable since
	// counts are bounded by filesystem dir count.
	var buf [20]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[pos:])
}
