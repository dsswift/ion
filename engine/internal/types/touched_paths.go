package types

import (
	"context"
	"sync"
)

// TouchedPathSink is a per-run, concurrency-safe accumulator of filesystem
// paths that tools touched during execution. Tools record the absolute path
// they actually resolved and used; the run loop drains the accumulated set
// between turns to drive read-triggered nested context loading
// (progressive AGENTS.md/ION.md descent).
//
// The sink is never serialized — it carries no wire/contract surface. It is
// installed on the tool's context.Context via WithTouchedPathSink, mirroring
// WithTimeouts / WithShellConfig.
type TouchedPathSink struct {
	mu    sync.Mutex
	paths []string
}

// NewTouchedPathSink returns an empty sink ready for concurrent writes.
func NewTouchedPathSink() *TouchedPathSink {
	return &TouchedPathSink{}
}

// Add records a touched path. Safe for concurrent use by multiple tool
// goroutines (the run executes tool calls under an errgroup). Empty paths and
// a nil receiver are ignored so callers can record unconditionally after
// resolution without pre-checking.
func (s *TouchedPathSink) Add(path string) {
	if s == nil || path == "" {
		return
	}
	s.mu.Lock()
	s.paths = append(s.paths, path)
	s.mu.Unlock()
}

// DrainAndClear returns the paths accumulated since the last drain and resets
// the sink to empty. Safe to call concurrently with Add. Returns nil when the
// sink is nil or empty.
func (s *TouchedPathSink) DrainAndClear() []string {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.paths) == 0 {
		return nil
	}
	out := s.paths
	s.paths = nil
	return out
}

type touchedPathSinkKey struct{}

// WithTouchedPathSink stores a TouchedPathSink in the context so tools can
// record touched paths without changing the Execute signature. Mirrors
// WithShellConfig / WithTimeouts.
func WithTouchedPathSink(ctx context.Context, s *TouchedPathSink) context.Context {
	return context.WithValue(ctx, touchedPathSinkKey{}, s)
}

// TouchedPathSinkFrom retrieves the TouchedPathSink from the context, or nil if
// none is installed. The sink's methods are nil-safe, so callers can use the
// result directly.
func TouchedPathSinkFrom(ctx context.Context) *TouchedPathSink {
	s, _ := ctx.Value(touchedPathSinkKey{}).(*TouchedPathSink)
	return s
}

// RecordTouchedPath is a nil-safe convenience that records a touched path on
// the sink installed in ctx, if any. When no sink is installed (direct
// ExecuteTool callers, tests, sub-flows that don't drive nested loading) it is
// a no-op. Tools call this with the absolute path they actually resolved and
// used, after their own error guards.
func RecordTouchedPath(ctx context.Context, path string) {
	if path == "" {
		return
	}
	if s := TouchedPathSinkFrom(ctx); s != nil {
		s.Add(path)
	}
}
