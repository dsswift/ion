package extcontext

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DispatchRegistry is a thread-safe registry of active background dispatches,
// keyed by dispatch ID (the collision-safe agentID). Multiple concurrent
// dispatches of the same agent name each get their own entry with distinct
// IDs, so they are independently recallable.
//
// Two primary consumers:
//
//   - Recall: when the parent session needs to cancel a running background
//     agent, RecallByID targets a specific dispatch instance, RecallByName
//     cancels all dispatches matching a name, and RecallAll cancels everything
//     (session teardown).
//
//   - Background completion callbacks: when a background agent finishes, the
//     callback uses Deregister to clean up the entry.
//
// All exported methods are safe for concurrent use.
type DispatchRegistry struct {
	mu         sync.Mutex
	dispatches map[string]*activeDispatch
}

// activeDispatch holds the bookkeeping state for a single in-flight
// background agent dispatch.
type activeDispatch struct {
	// ID is the dispatch-specific unique identifier (the collision-safe
	// agentID, e.g. "dispatch-code-reviewer-1719500000000-a1b2c3d4e5f6").
	// This is the map key in DispatchRegistry.dispatches.
	ID string

	// Name is the agent name (e.g. "code-reviewer"). Multiple dispatches
	// of the same agent share this name but have distinct IDs.
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

	// ChildRunID is the child backend's activeRuns map key (the run ID
	// that SteerWithReason needs to locate the child's activeRun). Shape:
	// "{sessionKey}-{agentID}". Captured at RegisterWithID time from the
	// childReqID minted in dispatch_agent.go.
	ChildRunID string

	// ParentID is the dispatch ID of the parent that spawned this dispatch.
	// Empty for top-level dispatches (depth 1) whose parent is the
	// orchestrator at depth 0.
	ParentID string

	// Depth is the nesting depth of this dispatch. 1 = direct child of
	// orchestrator, 2 = grandchild, etc.
	Depth int
}

// NewDispatchRegistry returns an empty, ready-to-use registry.
func NewDispatchRegistry() *DispatchRegistry {
	utils.Debug("DispatchRegistry", "created new dispatch registry")
	return &DispatchRegistry{
		dispatches: make(map[string]*activeDispatch),
	}
}

// Register records an active background dispatch using the agent name as
// both ID and key. This is the backward-compatible path for callers that
// do not produce dispatch-specific IDs.
func (r *DispatchRegistry) Register(name string, cancel func(), child backend.RunBackend, sessionID string) {
	r.RegisterWithID(name, name, cancel, child, sessionID, "", 0)
}

// RegisterWithID records an active background dispatch with an explicit
// dispatch ID. This is the primary registration path for parallel-safe
// dispatches where each instance has a collision-safe agentID.
// parentID and depth record the dispatch's position in the nesting tree.
func (r *DispatchRegistry) RegisterWithID(id, name string, cancel func(), child backend.RunBackend, sessionID string, parentID string, depth int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.dispatches[id]; exists {
		utils.Warn("DispatchRegistry", fmt.Sprintf(
			"Register: overwriting existing dispatch id=%q name=%q session=%s", id, name, sessionID,
		))
	}

	r.dispatches[id] = &activeDispatch{
		ID:        id,
		Name:      name,
		Cancel:    cancel,
		Child:     child,
		SessionID: sessionID,
		ParentID:  parentID,
		Depth:     depth,
	}
	utils.Log("DispatchRegistry", fmt.Sprintf(
		"Register: id=%q name=%q session=%s depth=%d parentID=%q active=%d", id, name, sessionID, depth, parentID, len(r.dispatches),
	))
}

// SetChildRunID updates the ChildRunID on an existing dispatch entry.
// Called after registration when the child run ID is known. The child
// run ID is the key in the child backend's activeRuns map, needed by
// SteerByID to reach the child's steer channel. No-op if the dispatch
// ID is not found.
func (r *DispatchRegistry) SetChildRunID(id, childRunID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		utils.Debug("DispatchRegistry", fmt.Sprintf(
			"SetChildRunID: id=%q not found (no-op)", id,
		))
		return
	}
	d.ChildRunID = childRunID
	utils.Debug("DispatchRegistry", fmt.Sprintf(
		"SetChildRunID: id=%q childRunID=%q", id, childRunID,
	))
}

// Deregister removes a dispatch entry by ID. It is safe to call with an
// ID that does not exist (the call is a no-op). Deregister does NOT
// invoke the dispatch's Cancel function, use Recall if cancellation is
// desired.
func (r *DispatchRegistry) Deregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.dispatches[id]; !exists {
		utils.Debug("DispatchRegistry", fmt.Sprintf(
			"Deregister: id=%q not found (no-op)", id,
		))
		return
	}

	delete(r.dispatches, id)
	utils.Log("DispatchRegistry", fmt.Sprintf(
		"Deregister: id=%q removed active=%d", id, len(r.dispatches),
	))
}

// Get retrieves the active dispatch for the given ID. The second return
// value is false when no dispatch with that ID exists. The returned
// pointer is the live registry entry.
func (r *DispatchRegistry) Get(id string) (*activeDispatch, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok {
		utils.Debug("DispatchRegistry", fmt.Sprintf("Get: id=%q not found", id))
		return nil, false
	}
	utils.Debug("DispatchRegistry", fmt.Sprintf(
		"Get: id=%q name=%q session=%s depth=%d parentID=%q", id, d.Name, d.SessionID, d.Depth, d.ParentID,
	))
	return d, true
}

// Recall cancels an active background dispatch by name and removes it
// from the registry. When multiple dispatches share the same name, this
// cancels the FIRST one found (non-deterministic). For targeted recall,
// use RecallByID. Cascades: all descendant dispatches (children,
// grandchildren, etc.) are also cancelled and deregistered. Returns true
// if the named dispatch was found and cancelled.
func (r *DispatchRegistry) Recall(name string, reason string) bool {
	r.mu.Lock()
	var found *activeDispatch
	var foundID string
	for id, d := range r.dispatches {
		if d.Name == name {
			found = d
			foundID = id
			break
		}
	}
	if found == nil {
		r.mu.Unlock()
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"Recall: name=%q not found reason=%q", name, reason,
		))
		return false
	}

	// Collect descendants before deleting anything.
	var descIDs []string
	var descDispatches []*activeDispatch
	queue := []string{foundID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for id, d := range r.dispatches {
			if d.ParentID == cur {
				descIDs = append(descIDs, id)
				descDispatches = append(descDispatches, d)
				queue = append(queue, id)
			}
		}
	}

	delete(r.dispatches, foundID)
	for _, id := range descIDs {
		delete(r.dispatches, id)
	}
	r.mu.Unlock()

	// Cancel descendants first (leaves before parent) for orderly teardown.
	for i := len(descDispatches) - 1; i >= 0; i-- {
		dd := descDispatches[i]
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"Recall: cascade cancelling descendant id=%q name=%q reason=%q",
			descIDs[i], dd.Name, reason,
		))
		if dd.Cancel != nil {
			dd.Cancel()
		}
	}

	utils.Log("DispatchRegistry", fmt.Sprintf(
		"Recall: cancelling id=%q name=%q session=%s reason=%q descendants=%d active=%d",
		foundID, name, found.SessionID, reason, len(descDispatches), r.Count(),
	))

	if found.Cancel != nil {
		found.Cancel()
	} else {
		utils.Error("DispatchRegistry", fmt.Sprintf(
			"Recall: id=%q name=%q has nil Cancel func, dispatch leaked", foundID, name,
		))
	}

	return true
}

// RecallByID cancels a specific dispatch by its unique ID and removes it
// from the registry. Cascades: all descendant dispatches are also
// cancelled. Returns true if the dispatch was found and cancelled.
func (r *DispatchRegistry) RecallByID(id string, reason string) bool {
	r.mu.Lock()
	d, exists := r.dispatches[id]
	if !exists {
		r.mu.Unlock()
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"RecallByID: id=%q not found reason=%q", id, reason,
		))
		return false
	}

	// Collect descendants before deleting anything.
	var descIDs []string
	var descDispatches []*activeDispatch
	queue := []string{id}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for did, dd := range r.dispatches {
			if dd.ParentID == cur {
				descIDs = append(descIDs, did)
				descDispatches = append(descDispatches, dd)
				queue = append(queue, did)
			}
		}
	}

	delete(r.dispatches, id)
	for _, did := range descIDs {
		delete(r.dispatches, did)
	}
	r.mu.Unlock()

	// Cancel descendants first (leaves before parent).
	for i := len(descDispatches) - 1; i >= 0; i-- {
		dd := descDispatches[i]
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"RecallByID: cascade cancelling descendant id=%q name=%q reason=%q",
			descIDs[i], dd.Name, reason,
		))
		if dd.Cancel != nil {
			dd.Cancel()
		}
	}

	utils.Log("DispatchRegistry", fmt.Sprintf(
		"RecallByID: cancelling id=%q name=%q session=%s reason=%q descendants=%d active=%d",
		id, d.Name, d.SessionID, reason, len(descDispatches), r.Count(),
	))

	if d.Cancel != nil {
		d.Cancel()
	} else {
		utils.Error("DispatchRegistry", fmt.Sprintf(
			"RecallByID: id=%q name=%q has nil Cancel func, dispatch leaked", id, d.Name,
		))
	}

	return true
}

// RecallAll cancels every active dispatch in the registry and clears it.
// The reason string is logged alongside each cancellation. Returns the
// number of dispatches that were recalled. This is the shutdown path,
// called when a session is torn down to ensure no orphaned background
// agents survive.
func (r *DispatchRegistry) RecallAll(reason string) int {
	r.mu.Lock()
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
			"RecallAll: cancelling id=%q name=%q session=%s reason=%q", d.ID, d.Name, d.SessionID, reason,
		))
		if d.Cancel != nil {
			d.Cancel()
		} else {
			utils.Error("DispatchRegistry", fmt.Sprintf(
				"RecallAll: id=%q name=%q has nil Cancel func, dispatch leaked", d.ID, d.Name,
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
// (background agents still running) vs. clear (stale orphans). When
// multiple dispatches share a name, the name appears once in the result.
func (r *DispatchRegistry) ActiveNames() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make(map[string]bool, len(r.dispatches))
	for _, d := range r.dispatches {
		names[d.Name] = true
	}
	return names
}

// SteerDispatchOutcome is a string-typed enum describing how a
// SteerByID call was resolved. It mirrors the backend.SteerResult
// values with an additional "not_found" for registry-level misses.
type SteerDispatchOutcome string

const (
	// SteerOutcomeDelivered: the steer message was buffered on the child's
	// steer channel and will be injected at the next drainSteer checkpoint.
	SteerOutcomeDelivered SteerDispatchOutcome = "delivered"
	// SteerOutcomeChannelFull: the child's steer channel has 4 pending
	// messages; no room for another.
	SteerOutcomeChannelFull SteerDispatchOutcome = "channel_full"
	// SteerOutcomeNoRun: the dispatch exists in the registry but its child
	// backend has no active run matching the ChildRunID.
	SteerOutcomeNoRun SteerDispatchOutcome = "no_run"
	// SteerOutcomeNotFound: no dispatch with that ID exists in the registry.
	SteerOutcomeNotFound SteerDispatchOutcome = "not_found"
)

// Steerable is a narrow interface for backends that support in-process
// steer delivery. Both *backend.ApiBackend and *backend.HybridBackend
// implement it. This mirrors the session-local steerable interface
// (session/agent.go) but is exported so the dispatch registry (a
// different package) can type-assert against it.
type Steerable interface {
	SteerWithReason(requestID, message string) backend.SteerResult
}

// SteerByID delivers a steering message to a running background dispatch
// identified by its public dispatch ID. It looks up the registry entry,
// type-asserts the stored Child backend to the Steerable interface, and
// calls SteerWithReason with the entry's ChildRunID. The backend's
// SteerResult is mapped to a SteerDispatchOutcome so the caller gets a
// four-value verdict: delivered, channel_full, no_run, or not_found.
func (r *DispatchRegistry) SteerByID(dispatchID, message string) SteerDispatchOutcome {
	r.mu.Lock()
	entry, ok := r.dispatches[dispatchID]
	if !ok {
		r.mu.Unlock()
		utils.Log("DispatchRegistry", fmt.Sprintf(
			"SteerByID: id=%q not found msgLen=%d outcome=%s",
			dispatchID, len(message), SteerOutcomeNotFound,
		))
		return SteerOutcomeNotFound
	}
	child := entry.Child
	childRunID := entry.ChildRunID
	name := entry.Name
	r.mu.Unlock()

	s, ok := child.(Steerable)
	if !ok {
		utils.Warn("DispatchRegistry", fmt.Sprintf(
			"SteerByID: id=%q name=%q child backend does not implement Steerable outcome=%s",
			dispatchID, name, SteerOutcomeNoRun,
		))
		return SteerOutcomeNoRun
	}

	result := s.SteerWithReason(childRunID, message)
	var outcome SteerDispatchOutcome
	switch result {
	case backend.SteerResultDelivered:
		outcome = SteerOutcomeDelivered
	case backend.SteerResultChannelFull:
		outcome = SteerOutcomeChannelFull
	case backend.SteerResultNoRun:
		outcome = SteerOutcomeNoRun
	default:
		outcome = SteerOutcomeNoRun
	}

	utils.Log("DispatchRegistry", fmt.Sprintf(
		"SteerByID: id=%q name=%q childRunID=%q msgLen=%d backendResult=%s outcome=%s",
		dispatchID, name, childRunID, len(message), result, outcome,
	))
	return outcome
}
