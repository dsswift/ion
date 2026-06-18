package types

import "time"

// WorkspaceConfig holds engine-wide limits for the filesystem-watch and
// session-lifecycle subsystems. Harness engineers override these via
// engine.json's "workspace" block. The struct is nil-safe: every accessor
// accepts a nil receiver and a zero field and returns the compiled default,
// matching the TimeoutsConfig convention.
//
// These values are opinionated defaults, not policy the engine imposes. A
// consumer running enormous monorepos may raise the directory cap; a consumer
// with aggressive client reconnect behavior may shorten or lengthen the reap
// grace window. The engine ships sensible defaults and exposes every knob.
type WorkspaceConfig struct {
	// SessionReapGraceMs is how long a session whose last owning client
	// connection has disconnected is kept alive before the engine reaps it
	// (full StopSession teardown, releasing the pooled workspace watcher and
	// its file descriptors). A client that reconnects and re-addresses the
	// same session key within this window cancels the reap, so a transient
	// socket flap or a desktop relaunch never tears down a live session.
	//
	// Tuning: long enough to tolerate the consumer's worst-case client
	// restart; short enough that orphaned sessions (and their ~1-FD-per-
	// watched-directory watchers) cannot accumulate across reconnect churn
	// and exhaust the process file-descriptor limit. Zero means the compiled
	// default (300000 = 5min).
	SessionReapGraceMs int64 `json:"sessionReapGraceMs,omitempty"` // default: 300000 (5min)

	// MaxWatchedDirs caps the number of directories a single workspace
	// watcher attaches a filesystem descriptor to. Each watched directory
	// consumes one kqueue FD (macOS) or inotify watch (Linux), so an
	// unbounded walk of a pathological tree (symlink cycle, giant monorepo,
	// or a root mistakenly pointed at "/" or "$HOME") can exhaust the
	// per-process FD limit. When the cap is reached the watcher keeps working
	// for the directories it did attach and stops descending.
	//
	// Tuning: comfortably above the consumer's largest real working tree, but
	// below the FD ceiling even with several watchers running concurrently.
	// Zero means the compiled default (50000).
	MaxWatchedDirs int `json:"maxWatchedDirs,omitempty"` // default: 50000
}

// SessionReapGrace returns the orphaned-session reap grace window
// (default 5min). Nil-safe.
func (w *WorkspaceConfig) SessionReapGrace() time.Duration {
	if w == nil || w.SessionReapGraceMs == 0 {
		return 300000 * time.Millisecond
	}
	return time.Duration(w.SessionReapGraceMs) * time.Millisecond
}

// MaxWatchedDirsOr returns the per-watcher directory cap (default 50000).
// Nil-safe.
func (w *WorkspaceConfig) MaxWatchedDirsOr() int {
	if w == nil || w.MaxWatchedDirs == 0 {
		return 50000
	}
	return w.MaxWatchedDirs
}

// MergeWorkspace copies non-zero fields from src into dst. Both pointers may
// be nil; returns the merged result (or nil if both are nil). Mirrors
// MergeTimeouts.
func MergeWorkspace(dst, src *WorkspaceConfig) *WorkspaceConfig {
	if src == nil {
		return dst
	}
	if dst == nil {
		dup := *src
		return &dup
	}
	if src.SessionReapGraceMs != 0 {
		dst.SessionReapGraceMs = src.SessionReapGraceMs
	}
	if src.MaxWatchedDirs != 0 {
		dst.MaxWatchedDirs = src.MaxWatchedDirs
	}
	return dst
}
