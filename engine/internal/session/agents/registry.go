// Package agents manages agent handles, specs, and state pills for a single
// session. Thread-safe with its own mutex.
package agents

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
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
//
// CAUTION: name-keyed matching means two concurrent dispatches of the same
// agent name will collide on one slot. Use AppendOrUpdateByID for dispatch
// paths that need per-instance isolation (each dispatch gets its own slot
// keyed by its unique dispatch ID).
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

// AppendOrUpdateByID atomically finds an existing state by its unique ID
// and applies the updater, or appends a new entry if no match exists.
// Unlike AppendOrUpdate (name-keyed), this gives each concurrent dispatch
// of the same agent name its own slot, so UpdateStateByID always lands on
// the correct instance. Returns true if an existing entry was updated.
func (r *Registry) AppendOrUpdateByID(state types.AgentStateUpdate, updater func(*types.AgentStateUpdate)) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.states {
		if r.states[i].ID == state.ID {
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

// UpdateState finds all states with the given name and applies the updater
// to each. Multiple entries may share the same name when concurrent
// dispatches of the same agent each get their own ID-keyed slot.
// The abort path relies on this to cancel every running instance of a name.
func (r *Registry) UpdateState(name string, updater func(*types.AgentStateUpdate)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.states {
		if r.states[i].Name == name {
			updater(&r.states[i])
		}
	}
}

// UpdateStateByID finds a state by its unique ID and applies the updater.
// Logs a warning if no slot matches, which indicates the terminal update
// for a dispatch landed nowhere (the root cause of phantom "running"
// agent states that made the desktop show "waiting for N background agents"
// indefinitely).
func (r *Registry) UpdateStateByID(id string, updater func(*types.AgentStateUpdate)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.states {
		if r.states[i].ID == id {
			updater(&r.states[i])
			return
		}
	}
	utils.Warn("AgentRegistry", fmt.Sprintf(
		"UpdateStateByID: no slot found for id=%q (terminal update landed nowhere, agent may appear stuck as running)", id,
	))
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

// ClearRunningStatesExceptIDs removes states with status "running" UNLESS their
// unique ID appears in the keepIDs set. This is the ID-keyed peer of
// ClearRunningStatesExcept.
//
// Engine-managed dispatch slots are keyed by their unique dispatch ID
// (AppendOrUpdateByID / UpdateStateByID), and the dispatch lifecycle addresses
// them by that ID at every depth. Preserving by ID — rather than by name —
// keeps a nested (depth-2+) dispatch's still-running slot alive through a
// parent run-exit clear, so its later terminal UpdateStateByID lands on a real
// slot instead of logging "no slot found" and leaving the agent stuck
// "running". Name-keyed preservation cannot do this: it collapses every
// dispatch sharing a name to one key, and a nested dispatch whose name is not
// in the keep-set is swept. Used together with ClearRunningStatesExcept in
// handleRunExit (ID covers engine dispatch slots; name covers extension-roster
// rows that carry no engine dispatch ID).
func (r *Registry) ClearRunningStatesExceptIDs(keepIDs map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.states[:0] // reuse backing array
	for _, s := range r.states {
		if s.Status != "running" || keepIDs[s.ID] {
			kept = append(kept, s)
		}
	}
	r.states = kept
}

// ClearRunningStatesExceptIDsOrNames removes states with status "running"
// UNLESS their unique ID is in keepIDs OR their name is in keepNames. This is
// the combined preservation the run-exit clear needs: engine-managed dispatch
// slots are preserved by ID (covers nested dispatches at every depth, whose
// names collapse under name-only keying), while extension-roster rows that
// carry no engine dispatch ID are preserved by name.
//
// The OR must be evaluated atomically in one pass. Calling the ID-keyed and
// name-keyed clears in sequence would be wrong: the second pass would sweep the
// running slots the first pass intentionally kept.
func (r *Registry) ClearRunningStatesExceptIDsOrNames(keepIDs, keepNames map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.states[:0] // reuse backing array
	for _, s := range r.states {
		if s.Status != "running" || keepIDs[s.ID] || keepNames[s.Name] {
			kept = append(kept, s)
		}
	}
	r.states = kept
}

// MergedSnapshot returns a combined slice of extension-managed states and
// engine-managed states. When both contain an entry with the same name,
// the engine-managed entry wins (it carries richer metadata: task,
// conversationId, progress). This prevents duplicate rows in the agent
// consumer view when the extension's roster and the engine's dispatch state
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
	keptExt := 0
	for _, ext := range r.lastExtStates {
		if !superseded[ext.Name] {
			merged = append(merged, ext)
			keptExt++
		}
	}

	// Name-grouping projection: merge same-Name engine entries into one
	// AgentStateUpdate per agent name for the emitted snapshot. The internal
	// r.states store stays ID-keyed (untouched) so UpdateStateByID /
	// AppendOrUpdateByID still target individual dispatches. This projection
	// prevents a consumer from receiving duplicate same-name rows when the
	// orchestrator dispatches the same agent name multiple times.
	grouped := groupByName(r.states)
	merged = append(merged, grouped...)

	// Observability: the merge is the single point where an extension roster
	// row and an engine dispatch row collapse into the one row consumers read.
	// consumers read metadata.dispatches[]. When that array fails to reach a
	// representative row (representative chosen with empty dispatches[]),
	// consumers receive a row with no per-dispatch detail.
	// Log the merge shape so that failure is a one-line log read, not a trace.
	utils.Debug("AgentRegistry", fmt.Sprintf(
		"MergedSnapshot: extStates=%d engineStates=%d superseded=%d keptExt=%d grouped=%d merged=%d",
		len(r.lastExtStates), len(r.states), len(superseded), keptExt, len(grouped), len(merged),
	))
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

// statusPriority returns a numeric priority for agent statuses.
// Higher values represent more-active states. Used by groupByName to pick the
// representative status when merging same-name entries.
func statusPriority(status string) int {
	switch status {
	case "running":
		return 4
	case "error":
		return 3
	case "done":
		return 2
	case "cancelled":
		return 1
	default:
		return 0
	}
}

// groupByName merges same-Name entries into one AgentStateUpdate per agent
// name. This is a projection-only operation: it builds new entries from copies,
// never mutating the source slice or aliasing its metadata maps.
//
// For each name group:
//   - dispatches[] arrays from every entry's metadata are merged (order preserved).
//   - The most-active status wins (running > error > done > cancelled).
//   - The most-recently-active entry's top-level metadata (task, model,
//     displayName, lastWork) is used as the representative.
func groupByName(states []types.AgentStateUpdate) []types.AgentStateUpdate {
	if len(states) == 0 {
		return nil
	}

	// Preserve insertion order via an ordered name list.
	var nameOrder []string
	groups := make(map[string][]int) // name -> indices into states
	for i, s := range states {
		if _, exists := groups[s.Name]; !exists {
			nameOrder = append(nameOrder, s.Name)
		}
		groups[s.Name] = append(groups[s.Name], i)
	}

	out := make([]types.AgentStateUpdate, 0, len(nameOrder))
	for _, name := range nameOrder {
		indices := groups[name]

		// Single entry: deep-copy metadata and emit directly.
		if len(indices) == 1 {
			single := copyAgentState(states[indices[0]])
			// Ensure each dispatch member in the snapshot carries an explicit,
			// non-empty dispatchId (plus dispatchParentId/dispatchDepth/status)
			// so a consumer can address individual dispatches even for a
			// single-dispatch agent. Additive: existing keys ("id", etc.) are
			// left intact; this only fills the identity fields.
			ensureDispatchIdentitiesInMeta(single.Metadata)
			// A single entry that carries dispatch metadata (a task) but no
			// dispatches[] array is the pathological shape a consumer cannot
			// expand: a representative row whose metadata.dispatches[] is empty.
			// Surface it so
			// the symptom has a greppable signature.
			if isDispatchBearing(single.Metadata) && dispatchesLen(single.Metadata) == 0 {
				utils.Debug("AgentRegistry", fmt.Sprintf(
					"groupByName: name=%q status=%q single entry has dispatch task but empty dispatches[] (consumers cannot expand per-dispatch detail)",
					name, single.Status,
				))
			}
			out = append(out, single)
			continue
		}

		// Multiple entries: pick the representative (most-active status,
		// ties broken by last position in slice which is most-recently-added).
		bestIdx := indices[0]
		bestPri := statusPriority(states[bestIdx].Status)
		for _, idx := range indices[1:] {
			pri := statusPriority(states[idx].Status)
			if pri >= bestPri {
				bestPri = pri
				bestIdx = idx
			}
		}

		representative := copyAgentState(states[bestIdx])

		// Merge dispatches[] from all entries in order, de-duplicating by
		// each dispatch's stable "id". Without this de-dup the projection is
		// not idempotent: re-grouping an array that already carries an
		// instance (e.g. after a persist -> rehydrate round-trip that restored
		// the same dispatch into more than one slot) would append it again,
		// growing the array by one copy per cycle. Keying on "id" counts each
		// instance exactly once regardless of how many slots reference it.
		// Entries with no usable "id" fall back to append so malformed members
		// are preserved rather than silently dropped.
		var mergedDispatches []interface{}
		seenDispatchIDs := make(map[string]bool)
		for _, idx := range indices {
			src := states[idx].Metadata
			if src == nil {
				continue
			}
			if d, ok := src["dispatches"].([]interface{}); ok {
				for _, entry := range d {
					if id, ok := dispatchEntryID(entry); ok {
						if seenDispatchIDs[id] {
							continue
						}
						seenDispatchIDs[id] = true
					}
					member := deepCopyDispatch(entry)
					// Preserve per-dispatch identity in the collapsed snapshot:
					// stamp an explicit dispatchId (mirrored from the stable
					// "id") plus dispatchParentId/dispatchDepth/status onto each
					// member. Same-name dispatches that share a representative
					// row therefore remain distinct, ID-addressable entries in
					// the emitted dispatches[] rather than collapsing into an
					// anonymous blob. Additive only — no existing key is removed.
					ensureDispatchIdentity(member)
					mergedDispatches = append(mergedDispatches, member)
				}
			}
		}
		if representative.Metadata == nil {
			representative.Metadata = map[string]interface{}{}
		}
		if len(mergedDispatches) > 0 {
			representative.Metadata["dispatches"] = mergedDispatches
		}

		// Observability: a same-name group that collapses N entries into one
		// representative is where dispatch rows can be lost. Log the chosen
		// representative's status and the merged dispatches[] length; flag the
		// case where a dispatch-bearing group still projects to an empty
		// dispatches[] (the empty-detail symptom).
		if isDispatchBearing(representative.Metadata) && len(mergedDispatches) == 0 {
			utils.Debug("AgentRegistry", fmt.Sprintf(
				"groupByName: name=%q entries=%d repStatus=%q merged dispatches[] is EMPTY despite dispatch task (consumers cannot expand per-dispatch detail)",
				name, len(indices), representative.Status,
			))
		} else {
			utils.Debug("AgentRegistry", fmt.Sprintf(
				"groupByName: name=%q entries=%d repStatus=%q mergedDispatches=%d",
				name, len(indices), representative.Status, len(mergedDispatches),
			))
		}

		out = append(out, representative)
	}
	return out
}

// isDispatchBearing reports whether an agent's metadata carries dispatch
// identity (a non-empty "task"). Roster-only rows (idle specialists with no
// active dispatch) have no task; engine dispatch rows always do. Used by the
// projection logging to distinguish "this row should have dispatches[]" from
// "this row is a plain roster entry" when flagging an empty dispatches[].
func isDispatchBearing(meta map[string]interface{}) bool {
	if meta == nil {
		return false
	}
	task, _ := meta["task"].(string)
	return task != ""
}

// dispatchesLen returns the length of the metadata "dispatches" array, or 0
// when it is absent or not an array. Used only by projection logging.
func dispatchesLen(meta map[string]interface{}) int {
	if meta == nil {
		return 0
	}
	if d, ok := meta["dispatches"].([]interface{}); ok {
		return len(d)
	}
	return 0
}

// copyAgentState returns a shallow copy of the AgentStateUpdate with a
// deep-copied Metadata map (top-level keys copied, dispatches slice cloned).
func copyAgentState(s types.AgentStateUpdate) types.AgentStateUpdate {
	cp := s
	if s.Metadata != nil {
		cp.Metadata = make(map[string]interface{}, len(s.Metadata))
		for k, v := range s.Metadata {
			if k == "dispatches" {
				if d, ok := v.([]interface{}); ok {
					cloned := make([]interface{}, len(d))
					for i, entry := range d {
						cloned[i] = deepCopyDispatch(entry)
					}
					cp.Metadata[k] = cloned
					continue
				}
			}
			cp.Metadata[k] = v
		}
	}
	return cp
}

// deepCopyDispatch copies a single dispatch entry (map[string]interface{}).
// If the entry is not a map, it is returned as-is.
func deepCopyDispatch(entry interface{}) interface{} {
	m, ok := entry.(map[string]interface{})
	if !ok {
		return entry
	}
	cp := make(map[string]interface{}, len(m))
	for k, v := range m {
		cp[k] = v
	}
	return cp
}

// dispatchEntryID extracts the stable "id" of a dispatch entry (the
// collision-safe agentID minted at dispatch time). Returns the id and true
// when the entry is a map carrying a non-empty string "id"; returns false
// otherwise so callers can fall back to append-without-dedup for malformed
// or id-less members.
func dispatchEntryID(entry interface{}) (string, bool) {
	m, ok := entry.(map[string]interface{})
	if !ok {
		return "", false
	}
	id, ok := m["id"].(string)
	if !ok || id == "" {
		return "", false
	}
	return id, true
}

// ensureDispatchIdentity stamps the per-dispatch identity fields onto a single
// dispatch member map so each member stays distinct and addressable in the
// emitted engine_agent_state snapshot. It is additive and idempotent:
//
//   - dispatchId is mirrored from the stable "id" when absent or empty. This
//     is the field consumers key on to tell same-name dispatches apart.
//   - dispatchParentId / dispatchDepth are surfaced from the member's own
//     values when present (persisted in the conversation file, rehydrated into
//     metadata) so the parent/nesting attribution rides on each member.
//   - status is left as-is when present; no default is invented.
//
// Existing keys are never removed or renamed. A member with no usable "id"
// (malformed) is left untouched so it survives rather than gaining a bogus id.
func ensureDispatchIdentity(entry interface{}) {
	m, ok := entry.(map[string]interface{})
	if !ok {
		return
	}
	id, _ := m["id"].(string)
	if id == "" {
		// No stable id to mirror; leave the member untouched.
		return
	}
	if existing, _ := m["dispatchId"].(string); existing == "" {
		m["dispatchId"] = id
	}
	// dispatchParentId / dispatchDepth are already carried on the member when
	// the persist/rehydrate path stamped them (Commits 1 & 2). We do not
	// fabricate defaults here — their absence is a legitimate "top-level /
	// unknown" signal that consumers interpret. status likewise passes through.
}

// ensureDispatchIdentitiesInMeta applies ensureDispatchIdentity to every member
// of a metadata map's "dispatches" array, if present. Used on the single-entry
// projection path so a lone dispatch still emits an explicit dispatchId.
func ensureDispatchIdentitiesInMeta(meta map[string]interface{}) {
	if meta == nil {
		return
	}
	d, ok := meta["dispatches"].([]interface{})
	if !ok {
		return
	}
	for _, entry := range d {
		ensureDispatchIdentity(entry)
	}
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
