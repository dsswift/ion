package extcontext

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DispatchRegistry is a thread-safe registry of active background dispatches,
// keyed by agent name. It serves two primary consumers:
//
//   - Recall (Phase 4): when the parent session needs to cancel a running
//     background agent (e.g. the user types /recall or the session is torn
//     down), Recall and RecallAll look up the active dispatch and invoke its
//     cancel function.
//
//   - Background completion callbacks (Phase 1): when a background agent
//     finishes, the callback uses Get to locate the dispatch entry so it can
//     route the result back to the correct parent session and clean up via
//     Deregister.
//
// All exported methods are safe for concurrent use.
type DispatchRegistry struct {
	mu        sync.Mutex
	dispatches map[string]*activeDispatch
}

// activeDispatch holds the bookkeeping state for a single in-flight
// background agent dispatch. The Name field matches the map key in
// DispatchRegistry.dispatches and is stored redundantly so callers of Get
// receive a self-describing value without needing to carry the key.
type activeDispatch struct {
	// Name is the agent name that identifies this dispatch (e.g.
	// "code-reviewer", "test-runner"). Unique within a registry.
	Name string

	// Cancel stops the background dispatch. Calling Cancel on an already-
	// cancelled dispatch is a no-op (the function must be idempotent).
	Cancel func()

	// Child is the RunBackend that owns the background agent's run loop.
	// Callers may inspect Child.IsRunning or attach additional event
	// handlers before the dispatch completes.
	Child backend.RunBackend

	// SessionID is the parent session that spawned this dispatch. Used by
	// completion callbacks to route results back to the correct session.
	SessionID string
}

// NewDispatchRegistry returns an empty, ready-to-use registry.
func NewDispatchRegistry() *DispatchRegistry {
	utils.Debug("DispatchRegistry", "created new dispatch registry")
	return &DispatchRegistry{
		dispatches: make(map[string]*activeDispatch),
	}
}

// Register records an active background dispatch. If a dispatch with the
// same name already exists it is silently overwritten — the caller is
// expected to Deregister or Recall the previous dispatch before reusing
// the name. A warning is logged when an overwrite occurs so operators can
// spot double-dispatch bugs in extension code.
func (r *DispatchRegistry) Register(name string, cancel func(), child backend.RunBackend, sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.dispatches[name]; exists {
		utils.Warn("DispatchRegistry", fmt.Sprintf(
			"Register: overwriting existing dispatch name=%q session=%s", name, sessionID,
		))
	}

	r.dispatches[name] = &activeDispatch{
		Name:      name,
		Cancel:    cancel,
		Child:     child,
		SessionID: sessionID,
	}
	utils.Log("DispatchRegistry", fmt.Sprintf(
		"Register: name=%q session=%s active=%d", name, sessionID, len(r.dispatches),
	))
}

// Deregister removes a dispatch entry by name. It is safe to call with a
// name that does not exist (the call is a no-op). Deregister does NOT
// invoke the dispatch's Cancel function — use Recall if cancellation is
// desired.
func (r *DispatchRegistry) Deregister(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.dispatches[name]; !exists {
		utils.Debug("DispatchRegistry", fmt.Sprintf(
			"Deregister: name=%q not found (no-op)", name,
		))
		return
	}

	delete(r.dispatches, name)
	utils.Log("DispatchRegistry", fmt.Sprintf(
		"Deregister: name=%q removed active=%d", name, len(r.dispatches),
	))
}

// Get retrieves the active dispatch for the given agent name. The second
// return value is false when no dispatch with that name exists. The
// returned pointer is the live registry entry — callers must not mutate
// it without holding their own synchronization.
func (r *DispatchRegistry) Get(name string) (*activeDispatch, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[name]
	if !ok {
		utils.Debug("DispatchRegistry", fmt.Sprintf("Get: name=%q not found", name))
		return nil, false
	}
	utils.Debug("DispatchRegistry", fmt.Sprintf(
		"Get: name=%q session=%s", name, d.SessionID,
	))
	return d, true
}

// Recall cancels an active background dispatch by name and removes it
// from the registry. The reason string is included in log output for
// observability (e.g. "user_recall", "session_teardown"). Returns true
// if a dispatch was found and cancelled, false otherwise.
func (r *DispatchRegistry) Recall(name string, reason string) bool {
	r.mu.Lock()
	d, exists := r.dispatches[name]
	if !exists {
		r.mu.Unlock()
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"Recall: name=%q not found reason=%q", name, reason,
		))
		return false
	}
	// Remove from registry before cancelling so concurrent Get calls
	// see a consistent state once Cancel starts tearing down the child.
	delete(r.dispatches, name)
	r.mu.Unlock()

	utils.Log("DispatchRegistry", fmt.Sprintf(
		"Recall: cancelling name=%q session=%s reason=%q active=%d",
		name, d.SessionID, reason, r.Count(),
	))

	if d.Cancel != nil {
		d.Cancel()
	} else {
		utils.Error("DispatchRegistry", fmt.Sprintf(
			"Recall: name=%q has nil Cancel func — dispatch leaked", name,
		))
	}

	return true
}

// RecallAll cancels every active dispatch in the registry and clears it.
// The reason string is logged alongside each cancellation. Returns the
// number of dispatches that were recalled. This is the shutdown path —
// called when a session is torn down to ensure no orphaned background
// agents survive.
func (r *DispatchRegistry) RecallAll(reason string) int {
	r.mu.Lock()
	// Snapshot and clear under the lock so new registrations that arrive
	// during the cancel sweep are not affected.
	snapshot := make([]*activeDispatch, 0, len(r.dispatches))
	for _, d := range r.dispatches {
		snapshot = append(snapshot, d)
	}
	r.dispatches = make(map[string]*activeDispatch)
	r.mu.Unlock()

	if len(snapshot) == 0 {
		utils.Debug("DispatchRegistry", fmt.Sprintf(
			"RecallAll: no active dispatches reason=%q", reason,
		))
		return 0
	}

	utils.Log("DispatchRegistry", fmt.Sprintf(
		"RecallAll: cancelling %d dispatch(es) reason=%q", len(snapshot), reason,
	))

	for _, d := range snapshot {
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"RecallAll: cancelling name=%q session=%s reason=%q", d.Name, d.SessionID, reason,
		))
		if d.Cancel != nil {
			d.Cancel()
		} else {
			utils.Error("DispatchRegistry", fmt.Sprintf(
				"RecallAll: name=%q has nil Cancel func — dispatch leaked", d.Name,
			))
		}
	}

	return len(snapshot)
}

// Count returns the number of currently active dispatches. Useful for
// diagnostics, tests, and log context.
func (r *DispatchRegistry) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.dispatches)
}

// ActiveNames returns the set of currently-active dispatch agent names.
// Used by handleRunExit to decide which running agent states to preserve
// (background agents still running) vs. clear (stale orphans).
func (r *DispatchRegistry) ActiveNames() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make(map[string]bool, len(r.dispatches))
	for name := range r.dispatches {
		names[name] = true
	}
	return names
}
