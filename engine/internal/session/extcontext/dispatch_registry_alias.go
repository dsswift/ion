package extcontext

import (
	"sort"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Consumer-supplied dispatch aliases. Split from dispatch_registry.go for the
// file-size cap; same package, same lock.

// RegisterAlias records a consumer-supplied identifier as an alternate name for
// a dispatch's canonical engine ID, so a steer/recall addressed with the
// consumer's own key resolves to the real dispatch instead of missing it.
//
// Registering an alias is always additive and never rebinds: an alias that
// already points somewhere is left alone (logged at WARN, since two dispatches
// claiming one consumer key means the consumer's keys are not unique and the
// engine must not silently pick a winner). An alias equal to the canonical ID
// is a no-op — the direct lookup already covers it, and storing it would leave
// a self-referential entry to reason about.
func (r *DispatchRegistry) RegisterAlias(alias, canonicalID string) {
	if alias == "" || canonicalID == "" || alias == canonicalID {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.aliases == nil {
		r.aliases = make(map[string]string)
	}
	if existing, ok := r.aliases[alias]; ok {
		if existing != canonicalID {
			utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "registeralias: alias already bound to a different dispatch, keeping the original", map[string]any{
				"alias": alias, "run_id": existing, "rejected_run_id": canonicalID,
			})
		}
		return
	}
	r.aliases[alias] = canonicalID
	indexLive(alias, r)
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "registeralias: consumer dispatch id aliased to canonical id", map[string]any{
		"alias": alias, "run_id": canonicalID, "max": len(r.aliases),
	})
}

// resolveIDLocked maps any accepted dispatch identifier to a live canonical ID.
// A direct hit always wins over an alias, so the engine's own ID space can
// never be shadowed by a consumer key. Returns the resolved ID and whether it
// names a live entry; the second return distinguishes "resolved through an
// alias" so callers can log how a steer found its target.
//
// Caller must hold r.mu.
func (r *DispatchRegistry) resolveIDLocked(id string) (resolved string, viaAlias bool, ok bool) {
	if _, direct := r.dispatches[id]; direct {
		return id, false, true
	}
	if canonical, aliased := r.aliases[id]; aliased {
		if _, live := r.dispatches[canonical]; live {
			return canonical, true, true
		}
	}
	return id, false, false
}

// aliasesForLocked returns every alias bound to canonicalID, sorted. Caller
// must hold r.mu.
func (r *DispatchRegistry) aliasesForLocked(canonicalID string) []string {
	var out []string
	for alias, target := range r.aliases {
		if target == canonicalID {
			out = append(out, alias)
		}
	}
	sort.Strings(out)
	return out
}

// dropAliasesForLocked removes every alias bound to a canonical dispatch ID.
// Called when the dispatch leaves the live set (leaveLocked), so a live alias
// never outlives the dispatch it names and can never resolve onto a later,
// unrelated dispatch that reuses the consumer's key. The finished dispatch
// keeps its aliases on its terminal entry, where they are consulted only
// after live resolution has missed.
//
// Caller must hold r.mu.
func (r *DispatchRegistry) dropAliasesForLocked(canonicalID string) {
	for alias, target := range r.aliases {
		if target == canonicalID {
			delete(r.aliases, alias)
			unindexLive(alias, r)
			utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "deregister: dropped dispatch alias", map[string]any{
				"alias": alias, "run_id": canonicalID,
			})
		}
	}
}
