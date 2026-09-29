package sysmetrics

import "sync"

// watchSet tracks which connections are watching and at what interval.
// Watcher ids are opaque to this package; the server uses connection ids.
type watchSet struct {
	mu       sync.Mutex
	watchers map[string]*watcher
}

type watcher struct {
	intervalMs    int64
	lastDeliverMs int64
}

func newWatchSet() *watchSet {
	return &watchSet{watchers: map[string]*watcher{}}
}

// set adds or updates a watcher. intervalMs must already be clamped.
func (w *watchSet) set(id string, intervalMs int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if cur, ok := w.watchers[id]; ok {
		cur.intervalMs = intervalMs
		return
	}
	w.watchers[id] = &watcher{intervalMs: intervalMs}
}

// remove drops a watcher. It reports whether the id was watching.
func (w *watchSet) remove(id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.watchers[id]
	delete(w.watchers, id)
	return ok
}

// count returns the number of watchers.
func (w *watchSet) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.watchers)
}

// minInterval returns the smallest interval any watcher asked for, or 0 when
// nobody is watching.
func (w *watchSet) minInterval() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	var m int64
	for _, x := range w.watchers {
		if m == 0 || x.intervalMs < m {
			m = x.intervalMs
		}
	}
	return m
}

// due returns the watchers whose own interval has elapsed at nowMs, and marks
// them delivered. tickMs is the sampler's current interval: a watcher is due
// when at least its interval, less half a tick, has passed, so a 1000 ms
// watcher on a 250 ms tick receives every fourth sample rather than drifting
// to every fifth.
func (w *watchSet) due(nowMs, tickMs int64) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []string
	for id, x := range w.watchers {
		if x.lastDeliverMs == 0 || nowMs-x.lastDeliverMs >= x.intervalMs-tickMs/2 {
			x.lastDeliverMs = nowMs
			out = append(out, id)
		}
	}
	return out
}
