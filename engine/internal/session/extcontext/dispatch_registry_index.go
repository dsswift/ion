package extcontext

import (
	"sync"
	"sync/atomic"
)

// Process-wide index of live dispatch identifiers. Every live canonical
// dispatch ID and every consumer alias maps to the registry that holds it.
//
// A control request (steer, recall) resolves against one registry: the one
// its context was built with. When that registry misses an identifier that
// another registry in the process holds live, the request reached the wrong
// registry, or asked about a dispatch outside its session. Either way the
// caller cannot control it, and a list against the holding registry would
// show it running. The index is what lets the missing registry tell those
// two facts apart from "no such dispatch" and report the disagreement.
//
// Lock order: a registry's mu may be held while taking liveIndex.mu; never
// the reverse.

var registrySeq atomic.Uint64

var liveIndex = struct {
	mu sync.Mutex
	m  map[string]*DispatchRegistry
}{m: make(map[string]*DispatchRegistry)}

func indexLive(id string, r *DispatchRegistry) {
	liveIndex.mu.Lock()
	liveIndex.m[id] = r
	liveIndex.mu.Unlock()
}

// unindexLive removes id only while it still points at r, so a registry
// leaving an identifier never erases another registry's claim on it.
func unindexLive(id string, r *DispatchRegistry) {
	liveIndex.mu.Lock()
	if liveIndex.m[id] == r {
		delete(liveIndex.m, id)
	}
	liveIndex.mu.Unlock()
}

func liveRegistryFor(id string) *DispatchRegistry {
	liveIndex.mu.Lock()
	defer liveIndex.mu.Unlock()
	return liveIndex.m[id]
}

// joinLocked marks id as a new live member. Caller must hold r.mu.
func (r *DispatchRegistry) joinLocked(id string) {
	r.generation++
	indexLive(id, r)
}

// leaveLocked removes a live member and every alias bound to it. Caller must
// hold r.mu. The terminal entry, if any, must be recorded before this call,
// because recording reads the aliases this drops.
func (r *DispatchRegistry) leaveLocked(id string) {
	delete(r.dispatches, id)
	r.dropAliasesForLocked(id)
	r.generation++
	unindexLive(id, r)
}
