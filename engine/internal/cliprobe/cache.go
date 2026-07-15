package cliprobe

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Registry caches CLI probes per backend kind. list_models reads the cache
// (never probes synchronously on the hot path); Refresh repopulates it in the
// background at startup, on refresh_models, and after a login completes.
type Registry struct {
	mu      sync.RWMutex
	probes  map[string]Probe
	probeFn ProbeFunc
}

// NewRegistry returns an empty registry using the default (real-spawn) probe.
func NewRegistry() *Registry {
	return &Registry{probes: make(map[string]Probe), probeFn: DefaultProbe}
}

// SetProbeFunc overrides the probe implementation. Used by tests to inject
// deterministic probes instead of spawning real CLIs.
func (r *Registry) SetProbeFunc(fn ProbeFunc) {
	r.mu.Lock()
	r.probeFn = fn
	r.mu.Unlock()
}

// Refresh probes each kind and stores the result. Safe to call concurrently;
// each kind is probed with the current probe func.
func (r *Registry) Refresh(kinds []string) {
	r.mu.RLock()
	fn := r.probeFn
	r.mu.RUnlock()
	for _, kind := range kinds {
		p := fn(kind)
		r.mu.Lock()
		r.probes[kind] = p
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "cliprobe", "probed", map[string]any{
			"kind": kind, "installed": p.Installed, "authenticated": p.Authenticated, "models": len(p.Models),
		})
	}
}

// Get returns the cached probe for a kind.
func (r *Registry) Get(kind string) (Probe, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.probes[kind]
	return p, ok
}
