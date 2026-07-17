package extcontext

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DispatchStateEntry is a point-in-time snapshot of a single active dispatch.
// Returned by DispatchRegistry.Snapshot for the ext/list_dispatch_state RPC.
// Only active (running) dispatches appear; terminal entries are deregistered
// and therefore absent.
type DispatchStateEntry struct {
	// DispatchID is the collision-safe unique ID for this dispatch instance.
	DispatchID string `json:"dispatchId"`
	// Name is the agent name (e.g. "code-reviewer").
	Name string `json:"name"`
	// Status is always "running" — the registry only holds active dispatches.
	Status string `json:"status"`
	// ParentDispatchID is the dispatch ID of the parent that spawned this
	// dispatch. Empty for top-level dispatches (depth 1 whose parent is the
	// depth-0 orchestrator, which has no dispatch ID).
	ParentDispatchID string `json:"parentDispatchId,omitempty"`
	// Depth is the nesting depth. 1 = direct child of the orchestrator,
	// 2 = grandchild, etc.
	Depth int `json:"depth"`
	// StartedAt is the UTC wall-clock time when the dispatch was registered.
	StartedAt time.Time `json:"startedAt"`
	// ElapsedMs is the milliseconds elapsed since StartedAt at snapshot time.
	ElapsedMs int64 `json:"elapsedMs"`
}

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
	mu                 sync.Mutex
	dispatches         map[string]*activeDispatch
	totalRegistrations int // total lifetime RegisterWithID calls (audit/test)
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

	// AllowedSubAgents is the set of agent names THIS dispatch's agent is
	// permitted to dispatch in turn. It is a carry-forward constraint: it is
	// checked when this agent later dispatches a child (the eligibility guard
	// resolves it from the child's currentDispatchId, i.e. THIS dispatch's id,
	// and requires the grandchild's name to be a member). Empty means no
	// allowlist restriction on this agent's nested dispatches. Set via
	// SetAllowedSubAgents after registration.
	AllowedSubAgents []string

	// ChildConvID is the child conversation ID set once the child session
	// initialises and emits its SessionID. Updated via SetChildConvID.
	// Empty until the child session initialises.
	ChildConvID string

	// ReviveCh is the channel that runChild blocks on when the dispatch is
	// suspended (via ext/task_suspend). A send on ReviveCh causes runChild
	// to loop and restart the LLM run with the new conversation context
	// (the revive message is already in the conversation as a user turn
	// delivered by sendPrompt). Non-nil only while the dispatch is parked.
	// Protected by the registry mu when reading/writing the pointer itself;
	// channel sends occur outside the lock after the pointer is captured.
	ReviveCh chan struct{}

	// PendingChildren is the set of child dispatch IDs the suspended agent
	// is waiting on (for N-child fan-out via dispatch_agents). Each time a
	// child whose ID is in this set completes, the engine removes that ID.
	// When the set becomes empty, ReviveCh is signaled. Nil/empty means bare
	// suspend() — any sendPrompt revives immediately. Protected by registry mu.
	PendingChildren map[string]struct{}

	// StartedAt is the wall-clock time when the dispatch was registered.
	// Used by Snapshot to compute ElapsedMs without per-entry timers.
	StartedAt time.Time

	// reserved marks an entry that was created by Reserve before the full
	// dispatch bookkeeping (cancel, child, childRunID) was known. A reserved
	// entry is a real member of ActiveIDs/ActiveNames — its whole purpose is to
	// cover the dispatch's agent-state slot from the instant that slot becomes
	// sweepable — but it carries placeholder Cancel/Child until RegisterWithID
	// upgrades it. RegisterWithID clears this flag and treats the upgrade as
	// expected (no "overwriting existing dispatch" warning).
	reserved bool
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

// Reserve records the dispatch ID as active BEFORE the full bookkeeping
// (cancel, child backend, childRunID) is known, so ActiveIDs/ActiveNames cover
// the dispatch from the instant its agent-state slot is created. Without this,
// the slot is exposed as "running" (and broadcast) well before RegisterWithID
// runs at the tail of dispatch setup; a concurrent run-exit sweep in that
// window snapshots ActiveIDs without the dispatch and deletes its still-live
// slot, after which every later UpdateStateByID (progress and terminal) lands
// nowhere and the agent renders as perpetually running.
//
// The reservation is a placeholder: Cancel is a no-op and Child is nil until
// RegisterWithID upgrades the entry with the real values. No-op if an entry
// (reserved or full) already exists for the id, so a later RegisterWithID is
// still the single authority for the real bookkeeping.
func (r *DispatchRegistry) Reserve(id, name, parentID string, depth int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.dispatches[id]; exists {
		return
	}
	r.dispatches[id] = &activeDispatch{
		ID:        id,
		Name:      name,
		Cancel:    func() {},
		ParentID:  parentID,
		Depth:     depth,
		StartedAt: time.Now(),
		reserved:  true,
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "reserve", map[string]any{"run_id": id, "model": name, "count": depth, "max": len(r.dispatches)})
}

// RegisterWithID records an active background dispatch with an explicit
// dispatch ID. This is the primary registration path for parallel-safe
// dispatches where each instance has a collision-safe agentID.
// parentID and depth record the dispatch's position in the nesting tree.
func (r *DispatchRegistry) RegisterWithID(id, name string, cancel func(), child backend.RunBackend, sessionID string, parentID string, depth int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.totalRegistrations++

	if existing, exists := r.dispatches[id]; exists && !existing.reserved {
		// A non-reserved entry with this id already exists: a genuine
		// collision worth flagging. Upgrading a Reserve() placeholder is
		// expected, not a collision, so it is not warned.
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "register overwriting existing dispatch", map[string]any{"run_id": id, "model": name, "session_id": sessionID})
	}

	r.dispatches[id] = &activeDispatch{
		ID:        id,
		Name:      name,
		Cancel:    cancel,
		Child:     child,
		SessionID: sessionID,
		ParentID:  parentID,
		Depth:     depth,
		StartedAt: time.Now(),
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "register", map[string]any{"run_id": id, "model": name, "session_id": sessionID, "count": depth, "max": len(r.dispatches)})
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
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "set child run id not found", map[string]any{"run_id": id})
		return
	}
	d.ChildRunID = childRunID
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "set child run id", map[string]any{"run_id": id, "reason": childRunID})
}

// SetAllowedSubAgents records the set of agent names the dispatch identified
// by id is permitted to dispatch in turn. Called after registration once the
// dispatch's allowlist is known. No-op if the dispatch id is not found.
func (r *DispatchRegistry) SetAllowedSubAgents(id string, allowed []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "setallowedsubagents: not found (no-op)", map[string]any{"run_id": id})
		return
	}
	d.AllowedSubAgents = allowed
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "set allowed sub agents", map[string]any{"run_id": id, "count": len(allowed)})
}

// AllowedSubAgentsForID returns the allowlist recorded for the dispatch
// identified by id, and whether the dispatch exists. A registered dispatch
// with no allowlist returns (nil, true) -- the caller treats an empty/nil
// allowlist as "no restriction". A missing dispatch returns (nil, false).
func (r *DispatchRegistry) AllowedSubAgentsForID(id string) ([]string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "allowedsubagentsforid: not found", map[string]any{"run_id": id})
		return nil, false
	}
	return d.AllowedSubAgents, true
}

// Deregister removes a dispatch entry by ID. It is safe to call with an
// ID that does not exist (the call is a no-op). Deregister does NOT
// invoke the dispatch's Cancel function, use Recall if cancellation is
// desired.
func (r *DispatchRegistry) Deregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, exists := r.dispatches[id]
	if !exists {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "deregister not found", map[string]any{"run_id": id})
		return
	}

	// Invariant check: deregistering a dispatch whose child run is still active
	// is anomalous — it means either a race (Recall fired while the run was live
	// and then the normal Deregister path also ran) or a desync (panic recovery
	// deregistered but the run survived the panic). Log it so the next occurrence
	// is attributable to a specific code path rather than lost in log truncation.
	// Best-effort: IsRunning is false for ClaudeCodeBackend (external processes), which
	// is acceptable — the ERROR log on the in-process backends is what matters.
	if d.Child != nil && d.Child.IsRunning(d.ChildRunID) {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "deregister invariant violation removing registry entry while child run is active", map[string]any{
			"run_id": id, "model": d.Name, "session_id": d.SessionID,
		})
	}

	delete(r.dispatches, id)
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "deregister removed", map[string]any{"run_id": id, "count": len(r.dispatches)})
}

// Get retrieves the active dispatch for the given ID. The second return
// value is false when no dispatch with that ID exists. The returned
// pointer is the live registry entry.
func (r *DispatchRegistry) Get(id string) (*activeDispatch, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "get: not found", map[string]any{"run_id": id})
		return nil, false
	}
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "get", map[string]any{"run_id": id, "model": d.Name, "session_id": d.SessionID})
	return d, true
}

// NameForID returns the registered agent name for a dispatch ID. This is the
// authoritative way to resolve a dispatcher's own agent name from its
// dispatch ID -- the dispatch-eligibility guard uses it to enforce the
// self-dispatch rail (an agent may not dispatch an agent of its own name).
// Returns ("", false) when the id is not registered. Do NOT derive the name
// by string-splitting the "dispatch-<name>-<millis>-<suffix>" id: agent names
// can contain hyphens, so the registry is the only precise source.
func (r *DispatchRegistry) NameForID(id string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "nameforid: not found", map[string]any{"run_id": id})
		return "", false
	}
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "nameforid", map[string]any{"run_id": id, "model": d.Name})
	return d.Name, true
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
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: not found", map[string]any{"model": name, "reason": reason})
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
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: cascade cancelling descendant", map[string]any{"desc_i_ds_i": descIDs[i], "model": dd.Name, "reason": reason})
		if dd.Cancel != nil {
			dd.Cancel()
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: cancelling", map[string]any{"found_i_d": foundID, "model": name, "session_id": found.SessionID, "reason": reason, "count": len(descDispatches), "count_5": r.Count()})

	if found.Cancel != nil {
		found.Cancel()
	} else {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recall: has nil cancel func, dispatch leaked", map[string]any{"found_i_d": foundID, "model": name})
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
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: not found", map[string]any{"run_id": id, "reason": reason})
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
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cascade cancelling descendant", map[string]any{"desc_i_ds_i": descIDs[i], "model": dd.Name, "reason": reason})
		if dd.Cancel != nil {
			dd.Cancel()
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cancelling", map[string]any{"run_id": id, "model": d.Name, "session_id": d.SessionID, "reason": reason, "count": len(descDispatches), "count_5": r.Count()})

	if d.Cancel != nil {
		d.Cancel()
	} else {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallbyid: has nil cancel func, dispatch leaked", map[string]any{"run_id": id, "model": d.Name})
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
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "recallall: no active dispatches", map[string]any{"reason": reason})
		return 0
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallall: cancelling dispatch(es)", map[string]any{"count": len(snapshot), "reason": reason})

	for _, d := range snapshot {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallall: cancelling", map[string]any{"run_id": d.ID, "model": d.Name, "session_id": d.SessionID, "reason": reason})
		if d.Cancel != nil {
			d.Cancel()
		} else {
			utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallall: has nil cancel func, dispatch leaked", map[string]any{"run_id": d.ID, "model": d.Name})
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

// TotalRegistrations returns the lifetime count of RegisterWithID calls.
// Useful for verifying that a dispatch path (foreground or background)
// actually registered in the registry, even after deregistration has
// cleared the entry from the active map.
func (r *DispatchRegistry) TotalRegistrations() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.totalRegistrations
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

// ActiveIDs returns the set of currently-active dispatch IDs — the same
// per-dispatch unique IDs that RegisterWithID stores and that the agent-state
// store keys its slots on (AppendOrUpdateByID / UpdateStateByID). This is the
// ID-keyed peer of ActiveNames.
//
// handleRunExit uses it to decide, by dispatch ID, which running agent-state
// slots to preserve. Name-keyed preservation (ActiveNames) collapses every
// dispatch sharing a name to one key, so a nested (depth-2+) dispatch whose
// name is not in the keep-set at clear time has its still-running slot swept;
// its later terminal UpdateStateByID then lands on nothing and the agent is
// stuck "running". Keying preservation on the dispatch ID — the same identity
// the lifecycle already addresses slots by — closes that gap at every depth.
func (r *DispatchRegistry) ActiveIDs() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make(map[string]bool, len(r.dispatches))
	for id := range r.dispatches {
		ids[id] = true
	}
	return ids
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
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyid: not found", map[string]any{"run_id": dispatchID, "count": len(message), "steer_outcome_not_found": SteerOutcomeNotFound})
		return SteerOutcomeNotFound
	}
	child := entry.Child
	childRunID := entry.ChildRunID
	name := entry.Name
	r.mu.Unlock()

	s, ok := child.(Steerable)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "steerbyid: child backend does not implement steerable", map[string]any{"run_id": dispatchID, "model": name, "steer_outcome_no_run": SteerOutcomeNoRun})
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

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyid", map[string]any{"run_id": dispatchID, "model": name, "run_id_2": childRunID, "count": len(message), "result": result, "outcome": outcome})
	return outcome
}

// SteerByName delivers a steering message to a running background dispatch
// identified by its agent name. It iterates the registry to find the first
// entry where d.Name == name, then delegates to SteerByID on that entry's
// dispatch ID. Returns SteerOutcomeNotFound when no dispatch with that name
// exists. When multiple dispatches share a name, the first one found is
// steered (non-deterministic order, matching Recall's existing semantics).
// Use SteerByID for precise targeting when a specific dispatch ID is known.
func (r *DispatchRegistry) SteerByName(name, message string) SteerDispatchOutcome {
	r.mu.Lock()
	var foundID string
	for id, d := range r.dispatches {
		if d.Name == name {
			foundID = id
			break
		}
	}
	r.mu.Unlock()

	if foundID == "" {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyname: not found", map[string]any{"model": name, "count": len(message), "steer_outcome_not_found": SteerOutcomeNotFound})
		return SteerOutcomeNotFound
	}

	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "steerbyname: resolved to id", map[string]any{"model": name, "run_id": foundID})
	return r.SteerByID(foundID, message)
}

// SetChildConvID records the child conversation ID for a dispatch entry once
// it is known (from the child's SessionInitEvent). No-op if the dispatch ID
// is not found.
func (r *DispatchRegistry) SetChildConvID(id, convID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		return
	}
	d.ChildConvID = convID
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "setchildconvid", map[string]any{"run_id": id, "run_id_1": convID})
}

// LiveConvIDs returns the child conversation IDs of all currently active
// dispatches. Dispatches that have not yet recorded a conversation ID return
// an empty string and are excluded from the result. Used by the aggregate-cost
// walk to include in-flight children whose tree entries are not yet persisted.
func (r *DispatchRegistry) LiveConvIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var ids []string
	for _, d := range r.dispatches {
		if d.ChildConvID != "" {
			ids = append(ids, d.ChildConvID)
		}
	}
	return ids
}

// Snapshot returns a point-in-time copy of every currently active dispatch as
// a slice of DispatchStateEntry values. Entries are always status="running"
// because the registry only holds in-flight dispatches (Deregister removes
// entries on completion). Thread-safe; safe to call from any goroutine.
func (r *DispatchRegistry) Snapshot() []DispatchStateEntry {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	entries := make([]DispatchStateEntry, 0, len(r.dispatches))
	for _, d := range r.dispatches {
		entries = append(entries, DispatchStateEntry{
			DispatchID:       d.ID,
			Name:             d.Name,
			Status:           "running",
			ParentDispatchID: d.ParentID,
			Depth:            d.Depth,
			StartedAt:        d.StartedAt,
			ElapsedMs:        now.Sub(d.StartedAt).Milliseconds(),
		})
	}
	return entries
}
