// Package agents manages agent handles, specs, and state pills for a single
// session. Thread-safe with its own mutex.
package agents

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// Registry manages agent handles, specs, and state pills for a single session.
type Registry struct {
	mu             sync.RWMutex
	handles        map[string]types.AgentHandle
	specs          map[string]types.AgentSpec
	states         []types.AgentStateUpdate
	lastExtStates  []types.AgentStateUpdate
}

// NewRegistry creates a ready-to-use Registry.
func NewRegistry() *Registry {
	return &Registry{
		handles: make(map[string]types.AgentHandle),
		specs:   make(map[string]types.AgentSpec),
	}
}

// --- Handles ---

// RegisterHandle registers an agent handle by name.
func (r *Registry) RegisterHandle(name string, handle types.AgentHandle) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handles[name] = handle
}

// DeregisterHandle removes an agent handle by name.
func (r *Registry) DeregisterHandle(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.handles, name)
}

// LookupHandle returns the handle for the given name, if registered.
func (r *Registry) LookupHandle(name string) (types.AgentHandle, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	h, ok := r.handles[name]
	return h, ok
}

// AllHandles returns a snapshot of every handle. The caller may read the map
// safely; mutations require going through Register/Deregister.
func (r *Registry) AllHandles() map[string]types.AgentHandle {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]types.AgentHandle, len(r.handles))
	for k, v := range r.handles {
		out[k] = v
	}
	return out
}

// ClearHandles removes every handle and returns their PIDs so the caller can
// kill the processes.
func (r *Registry) ClearHandles() (pids []int, names []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, handle := range r.handles {
		pids = append(pids, handle.PID)
		names = append(names, name)
	}
	r.handles = make(map[string]types.AgentHandle)
	return pids, names
}

// HandleCount returns the number of registered handles.
func (r *Registry) HandleCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.handles)
}

// --- Specs ---

// RegisterSpec registers an agent spec. Does nothing if spec.Name is empty.
func (r *Registry) RegisterSpec(spec types.AgentSpec) {
	if spec.Name == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.specs[spec.Name] = spec
}

// DeregisterSpec removes an agent spec by name.
func (r *Registry) DeregisterSpec(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.specs, name)
}

// LookupSpec returns the spec for the given name, if registered.
func (r *Registry) LookupSpec(name string) (types.AgentSpec, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	spec, ok := r.specs[name]
	return spec, ok
}

// LookupExtDisplayName searches the cached extension roster states for the
// given agent name and returns the displayName metadata value. Returns ""
// if no match or no displayName is set. This lets engine-managed code
// (dispatch_agent) inherit the human-friendly name the extension provides
// via its roster, even when no AgentSpec is registered.
func (r *Registry) LookupExtDisplayName(name string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, ext := range r.lastExtStates {
		if ext.Name == name {
			if dn, ok := ext.Metadata["displayName"].(string); ok && dn != "" {
				return dn
			}
			return ""
		}
	}
	return ""
}

// AllSpecNames returns the names of all registered specs.
func (r *Registry) AllSpecNames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.specs))
	for n := range r.specs {
		out = append(out, n)
	}
	return out
}

// --- States ---

// AppendOrUpdate atomically finds an existing state by name and updates it,
// or appends a new entry if none exists. Holds the write lock across the
// entire check-then-act to prevent duplicate entries from concurrent
// dispatches of the same specialist. Returns true if an existing entry was
// updated, false if a new entry was appended.
func (r *Registry) AppendOrUpdate(state types.AgentStateUpdate, updater func(*types.AgentStateUpdate)) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.states {
		if r.states[i].Name == state.Name {
			updater(&r.states[i])
			return true
		}
	}
	r.states = append(r.states, state)
	return false
}

// AppendState appends an agent state update.
func (r *Registry) AppendState(state types.AgentStateUpdate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = append(r.states, state)
}

// UpdateState finds a state by name and applies the updater function.
// When multiple entries share the same name (e.g., extension roster +
// engine-managed), the first match wins.
func (r *Registry) UpdateState(name string, updater func(*types.AgentStateUpdate)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.states {
		if r.states[i].Name == name {
			updater(&r.states[i])
			return
		}
	}
}

// UpdateStateByID finds a state by its unique ID and applies the updater.
func (r *Registry) UpdateStateByID(id string, updater func(*types.AgentStateUpdate)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.states {
		if r.states[i].ID == id {
			updater(&r.states[i])
			return
		}
	}
}

// FindStateIndex returns the index of the first state with the given name,
// or -1 if not found. Used to check whether a specialist already has an
// engine-managed state entry before appending a duplicate.
func (r *Registry) FindStateIndex(name string) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for i := range r.states {
		if r.states[i].Name == name {
			return i
		}
	}
	return -1
}

// ClearStates removes all states.
func (r *Registry) ClearStates() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = nil
}

// ClearRunningStates removes only states with status "running", preserving
// terminal states (done, error, cancelled) that carry conversation history.
// Called on run exit so that completed agent rows survive for post-run
// inspection and persistence.
func (r *Registry) ClearRunningStates() {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.states[:0] // reuse backing array
	for _, s := range r.states {
		if s.Status != "running" {
			kept = append(kept, s)
		}
	}
	r.states = kept
}

// ClearRunningStatesExcept removes states with status "running" UNLESS their
// name appears in the keepNames set. This is the dispatch-aware variant of
// ClearRunningStates: background dispatch agents that are still legitimately
// running are preserved while stale/orphaned running states are cleared.
func (r *Registry) ClearRunningStatesExcept(keepNames map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.states[:0] // reuse backing array
	for _, s := range r.states {
		if s.Status != "running" || keepNames[s.Name] {
			kept = append(kept, s)
		}
	}
	r.states = kept
}

// MergedSnapshot returns a combined slice of extension-managed states and
// engine-managed states. When both contain an entry with the same name,
// the engine-managed entry wins (it carries richer metadata: task,
// conversationId, progress). This prevents duplicate rows in the agent
// panel when the extension's roster and the engine's dispatch state
// both track the same specialist.
//
// An engine entry also supersedes an extension entry when its name is a
// numbered variant of the extension name (e.g. "cloud-architect-7"
// supersedes "cloud-architect"). This handles the case where the LLM
// called the generic Agent tool without a name, creating a numbered
// entry, while the extension roster has the base name.
func (r *Registry) MergedSnapshot() []types.AgentStateUpdate {
	r.mu.RLock()
	defer r.mu.RUnlock()

	// Build a set of extension names for reverse-prefix lookup.
	extNames := make(map[string]bool, len(r.lastExtStates))
	for _, ext := range r.lastExtStates {
		extNames[ext.Name] = true
	}

	// Collect engine-managed names and determine which extension entries
	// they supersede (exact match or numbered-variant match).
	superseded := make(map[string]bool, len(r.states))
	for _, s := range r.states {
		// Exact match
		if extNames[s.Name] {
			superseded[s.Name] = true
			continue
		}
		// Numbered-variant match: "cloud-architect-7" supersedes "cloud-architect"
		// by checking if stripping the last "-<digits>" suffix yields an ext name.
		base := stripNumberedSuffix(s.Name)
		if base != s.Name && extNames[base] {
			superseded[base] = true
		}
	}

	merged := make([]types.AgentStateUpdate, 0, len(r.lastExtStates)+len(r.states))
	for _, ext := range r.lastExtStates {
		if !superseded[ext.Name] {
			merged = append(merged, ext)
		}
	}
	merged = append(merged, r.states...)
	return merged
}

// stripNumberedSuffix removes a trailing "-<digits>" suffix from a name.
// Returns the original string if no such suffix exists.
// Examples: "cloud-architect-7" → "cloud-architect", "agent-1" → "agent-1" (no ext match expected)
func stripNumberedSuffix(name string) string {
	// Find the last dash
	lastDash := -1
	for i := len(name) - 1; i >= 0; i-- {
		if name[i] == '-' {
			lastDash = i
			break
		}
	}
	if lastDash <= 0 || lastDash == len(name)-1 {
		return name
	}
	// Check if everything after the last dash is digits
	suffix := name[lastDash+1:]
	for _, c := range suffix {
		if c < '0' || c > '9' {
			return name
		}
	}
	return name[:lastDash]
}

// CacheExtStates caches the most recent extension-emitted agent states.
func (r *Registry) CacheExtStates(states []types.AgentStateUpdate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastExtStates = make([]types.AgentStateUpdate, len(states))
	copy(r.lastExtStates, states)
}

// LastExtStates returns the cached extension agent states.
func (r *Registry) LastExtStates() []types.AgentStateUpdate {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]types.AgentStateUpdate, len(r.lastExtStates))
	copy(out, r.lastExtStates)
	return out
}

// IsDescendant checks if agent is a descendant of ancestor in the handle
// registry. Uses the ParentAgent chain with cycle protection.
func (r *Registry) IsDescendant(agent, ancestor string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return isDescendant(r.handles, agent, ancestor)
}

// isDescendant checks if agent is a descendant of ancestor in the given map.
func isDescendant(registry map[string]types.AgentHandle, agent, ancestor string) bool {
	visited := make(map[string]bool)
	current := agent
	for {
		handle, ok := registry[current]
		if !ok || handle.ParentAgent == "" {
			return false
		}
		if handle.ParentAgent == ancestor {
			return true
		}
		if visited[handle.ParentAgent] {
			return false // cycle protection
		}
		visited[current] = true
		current = handle.ParentAgent
	}
}
