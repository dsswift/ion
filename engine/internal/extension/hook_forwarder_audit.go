// hook_forwarder_audit.go — records which result category each forwarder
// actually installs.
//
// sdk_hook_registry.go declares each hook's result category as data. That
// declaration is only trustworthy if it matches the forwarder that really
// runs, and nothing about a `map` literal forces that. So every
// register*Forwarder helper calls noteForwarder with the category it is
// about to install, and TestHookRegistryMatchesForwarders asserts the
// recorded map equals the declared one.
//
// The recording is unconditional rather than test-only on purpose: a
// test-only hook would be a second code path, and a second code path is
// exactly what could drift. The cost is one map insert per hook at host
// construction.
package extension

import "sync"

// forwarderAudit records hook → installed result category for one host.
type forwarderAudit struct {
	mu   sync.Mutex
	seen map[string]hookResultKind
}

// noteForwarder records that a forwarder installing result category kind is
// being registered for hook.
func (h *Host) noteForwarder(hook string, kind hookResultKind) {
	h.forwarders.mu.Lock()
	defer h.forwarders.mu.Unlock()
	if h.forwarders.seen == nil {
		h.forwarders.seen = make(map[string]hookResultKind)
	}
	h.forwarders.seen[hook] = kind
}

// installedForwarders returns a copy of the recorded hook → result category
// map. Used by the registry guard test.
func (h *Host) installedForwarders() map[string]hookResultKind {
	h.forwarders.mu.Lock()
	defer h.forwarders.mu.Unlock()
	out := make(map[string]hookResultKind, len(h.forwarders.seen))
	for k, v := range h.forwarders.seen {
		out[k] = v
	}
	return out
}
