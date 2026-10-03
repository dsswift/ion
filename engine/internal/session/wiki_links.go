package session

import (
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/watcher"
	"github.com/dsswift/ion/engine/internal/wikilinks"
)

// ErrWikiLinkScanDisabled is returned when the link integrity scan is turned
// off in engine config. The workspace is not read.
var ErrWikiLinkScanDisabled = errors.New("wiki link integrity scan is disabled")

// propagationSettle is how long the rename worker waits after the last rename
// before it runs, so the renames of one operation (a directory move, a
// scripted batch) are handled in a single pass over the workspace.
// propagationMaxWait bounds that wait when renames keep arriving.
const (
	propagationSettle  = 150 * time.Millisecond
	propagationMaxWait = 2 * time.Second
)

// wikiLinkSettings is the wiki-link configuration resolved for one watcher.
type wikiLinkSettings struct {
	// enabled turns rename tracking on.
	enabled bool
	// propagate turns link rewriting on. Never true when enabled is false.
	propagate bool
	// extensions are the document extensions, lower case with a leading dot.
	extensions []string
}

// resolveWikiLinkSettings reads the wiki-link block of the engine config.
// Nil-safe: an absent config or block yields the compiled defaults.
func (m *Manager) resolveWikiLinkSettings() wikiLinkSettings {
	var cfg *types.WikiLinksConfig
	if m.config != nil {
		cfg = m.config.WikiLinks
	}
	return wikiLinkSettings{
		enabled:    cfg.IsEnabled(),
		propagate:  cfg.PropagationEnabled(),
		extensions: cfg.DocumentExtensions(),
	}
}

func (l wikiLinkSettings) fingerprint() string {
	if !l.enabled {
		return "off"
	}
	mode := "detect"
	if l.propagate {
		mode = "propagate"
	}
	return mode + ":" + strings.Join(l.extensions, ",")
}

// isDocument reports whether a root-relative path names a document.
func (l wikiLinkSettings) isDocument(rel string) bool {
	lower := strings.ToLower(rel)
	for _, ext := range l.extensions {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// options scopes a wikilinks operation to a workspace, honoring the same
// ignore patterns as the workspace watcher.
func (l wikiLinkSettings) options(root string, ignores []string) wikilinks.Options {
	return wikilinks.Options{
		Root:       root,
		Extensions: l.extensions,
		Ignore: func(rel string, isDir bool) bool {
			return watcher.MatchIgnore(ignores, rel, isDir)
		},
	}
}

// renameWorker handles the renames a workspace watcher reports, off the
// watcher's event goroutine. Renames are queued and handled in batches, one
// batch at a time, in the order they were observed: each rename is announced
// to the subscribers, then the batch's links are rewritten in a single pass
// and the report delivered.
type renameWorker struct {
	opts wikilinks.Options
	// propagate turns link rewriting on. When false the worker only announces.
	propagate bool
	announce  func(watcher.Info)
	deliver   func(types.WikiLinkPropagationReport)
	// settle and maxWait are fields so tests can shorten them.
	settle, maxWait time.Duration

	mu      sync.Mutex
	pending []watcher.Info
	closed  bool
	wake    chan struct{}
	done    chan struct{}
}

func newRenameWorker(opts wikilinks.Options, propagate bool, announce func(watcher.Info), deliver func(types.WikiLinkPropagationReport)) *renameWorker {
	w := &renameWorker{
		opts:      opts,
		propagate: propagate,
		announce:  announce,
		deliver:   deliver,
		settle:    propagationSettle,
		maxWait:   propagationMaxWait,
		wake:      make(chan struct{}, 1),
		done:      make(chan struct{}),
	}
	go w.loop()
	return w
}

// enqueue queues a rename. It never blocks.
func (w *renameWorker) enqueue(info watcher.Info) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "session.wikilinks", "rename dropped: worker closed", map[string]any{"root": w.opts.Root, "old": info.OldRelPath, "new": info.RelPath})
		return
	}
	w.pending = append(w.pending, info)
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// close stops the worker. Renames still queued are neither announced nor
// propagated.
func (w *renameWorker) close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	dropped := len(w.pending)
	w.pending = nil
	w.mu.Unlock()
	close(w.done)
	utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "rename worker closed", map[string]any{"root": w.opts.Root, "dropped": dropped})
}

func (w *renameWorker) pendingCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.pending)
}

func (w *renameWorker) loop() {
	for {
		select {
		case <-w.done:
			return
		case <-w.wake:
		}
		if !w.waitForQuiet() {
			return
		}
		w.mu.Lock()
		batch := w.pending
		w.pending = nil
		w.mu.Unlock()
		if len(batch) == 0 {
			continue
		}

		renames := make([]types.WikiLinkRename, 0, len(batch))
		for _, info := range batch {
			w.announce(info)
			renames = append(renames, types.WikiLinkRename{OldPath: info.OldRelPath, NewPath: info.RelPath})
		}
		if !w.propagate {
			utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "renames announced, propagation off", map[string]any{"root": w.opts.Root, "renames": len(renames)})
			continue
		}

		utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "propagation started", map[string]any{"root": w.opts.Root, "renames": len(renames)})
		report, err := wikilinks.Propagate(w.opts, renames)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "session.wikilinks", "propagation failed", map[string]any{"root": w.opts.Root, "renames": len(renames), "error": err.Error()})
			continue
		}
		w.deliver(report)
	}
}

// waitForQuiet blocks until no rename has arrived for the settle window, or
// the maximum wait has passed. Returns false when the worker was closed.
func (w *renameWorker) waitForQuiet() bool {
	deadline := time.NewTimer(w.maxWait)
	defer deadline.Stop()
	for {
		seen := w.pendingCount()
		quiet := time.NewTimer(w.settle)
		select {
		case <-w.done:
			quiet.Stop()
			return false
		case <-deadline.C:
			quiet.Stop()
			return true
		case <-quiet.C:
			if w.pendingCount() == seen {
				return true
			}
		}
	}
}

// ScanWikiLinks runs the read-only link integrity scan over a session's
// working directory and returns every wiki link that names no single file.
// It honors the session's workspace ignore patterns. Returns
// ErrWikiLinkScanDisabled, without reading the workspace, when engine config
// turns the scan off.
func (m *Manager) ScanWikiLinks(key string) (types.WikiLinkIntegrityReport, error) {
	var cfg *types.WikiLinksConfig
	if m.config != nil {
		cfg = m.config.WikiLinks
	}
	if !cfg.IntegrityScanEnabled() {
		utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "scan refused: disabled by config", map[string]any{"key": key})
		return types.WikiLinkIntegrityReport{}, ErrWikiLinkScanDisabled
	}

	m.mu.RLock()
	s, ok := m.sessions[key]
	var root string
	var ignores []string
	if ok {
		root = s.config.WorkingDirectory
		ignores = resolveWatchIgnores(s.config)
	}
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "scan refused: session not found", map[string]any{"key": key})
		return types.WikiLinkIntegrityReport{}, errors.New("session not found: " + key)
	}
	if root == "" {
		utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "scan refused: session has no working directory", map[string]any{"key": key})
		return types.WikiLinkIntegrityReport{}, errors.New("session has no working directory")
	}

	report, err := wikilinks.Scan(m.resolveWikiLinkSettings().options(root, ignores))
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session.wikilinks", "scan failed", map[string]any{"key": key, "root": root, "error": err.Error()})
		return report, err
	}
	utils.LogWithFields(utils.LevelInfo, "session.wikilinks", "scan answered", map[string]any{
		"key": key, "root": root, "documents": report.DocumentsScanned, "links": report.LinksChecked, "broken": len(report.Broken),
	})
	return report, nil
}
