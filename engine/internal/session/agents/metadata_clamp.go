// metadata_clamp.go — size bounds for AgentStateUpdate.Metadata.
//
// AgentStateUpdate.Metadata is an untyped map[string]interface{}: an
// extension may put anything in it, and until this file existed the engine
// accepted whatever arrived and re-published it verbatim. On a
// complete-snapshot event that is a recurring cost, not a one-off — every
// agent's full metadata is re-serialised on every emission for the life of
// the session.
//
// In production that produced a 36,969,872-byte engine_agent_state carrying
// only 11 agents (~3.3 MB each), rebuilt byte-identical for 15+ hours. It
// exceeded the desktop's 6 MiB transport cap on all 1,873 attempts, so it was
// dropped every time: iOS went blind to agent state for the whole window
// while the desktop burned CPU building a frame nobody could receive. The
// engine had written all 35 MB down the NDJSON socket regardless, so every
// external wire consumer paid for it too.
//
// The producing extension is fixed separately. This is the engine's backstop:
// the engine owns the mechanism, so an ill-behaved or third-party extension
// must not be able to wedge every consumer of a session.
package agents

import (
	"strings"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Default bounds. Three tiers rather than one: a per-snapshot cap alone would
// let a single agent consume the whole budget and starve the other ten, and a
// per-value cap alone does not stop death-by-a-thousand-keys.
const (
	// DefaultMaxValueBytes bounds one metadata value. This is the tier that
	// catches the actual production bug (one giant string).
	DefaultMaxValueBytes = 4096
	// DefaultMaxEntryBytes bounds one agent's whole metadata map, after
	// per-value clamping. Catches many-small-keys growth.
	DefaultMaxEntryBytes = 65536
	// DefaultMaxSnapshotBytes bounds the whole roster. This is the tier that
	// catches an agent-COUNT explosion rather than per-agent bloat.
	DefaultMaxSnapshotBytes = 4 * 1024 * 1024
	// DefaultMaxDepth bounds recursion into nested maps and slices.
	DefaultMaxDepth = 4
	// DefaultMaxDispatchEntries bounds the dispatches[] history array on the
	// emitted snapshot. The engine appends one record per dispatch and
	// rehydrates them across restarts, so the array is a monotonic history —
	// the tier that catches growth the byte tiers cannot see coming until it
	// is already large.
	DefaultMaxDispatchEntries = 50
)

// LimitsDisabled is the sentinel an operator sets to switch a tier off.
const LimitsDisabled = -1

// truncationSuffix marks a clamped string so a consumer can tell the value was
// cut rather than authored short.
const truncationSuffix = "… (truncated)"

// protectedKeys are never REMOVED from a metadata map.
//
// Protection governs key retention only — a protected key's VALUE is still
// clamped like any other, or a single 3 MB displayName would walk straight
// through the bound via a protected path and reopen the bug.
//
// Two groups, for two different reasons:
//
//   - displayName is required by the engine's own payload validator
//     (extension/host_rpc_notifications.go emits engine_error with
//     ErrorCode "malformed_agent_state" when it is missing). Dropping it
//     would make the engine flag the payload it just clamped.
//   - type, visibility, invited, and the dispatch identity keys are what
//     consumers navigate by. iOS in particular defaults an absent visibility
//     to "ephemeral" and then renders ephemeral agents only while running, and
//     defaults an absent invited to false, which hides sticky rows — so
//     dropping either silently empties the agents panel on the phone. An
//     empty-looking-but-successful render is worse than a dropped frame.
var protectedKeys = map[string]bool{
	"displayName":      true,
	"type":             true,
	"visibility":       true,
	"invited":          true,
	"status":           true,
	"color":            true,
	"dispatchId":       true,
	"dispatchParentId": true,
	"dispatchDepth":    true,
	"dispatches":       true,
	"conversationId":   true,
}

// MetadataLimits is the resolved, ready-to-use bound set. Zero values mean
// "use the built-in default"; LimitsDisabled means "no bound for this tier".
type MetadataLimits struct {
	MaxValueBytes      int
	MaxEntryBytes      int
	MaxSnapshotBytes   int
	MaxDepth           int
	MaxDispatchEntries int
}

// DefaultMetadataLimits returns the built-in bounds.
func DefaultMetadataLimits() MetadataLimits {
	return MetadataLimits{
		MaxValueBytes:      DefaultMaxValueBytes,
		MaxEntryBytes:      DefaultMaxEntryBytes,
		MaxSnapshotBytes:   DefaultMaxSnapshotBytes,
		MaxDepth:           DefaultMaxDepth,
		MaxDispatchEntries: DefaultMaxDispatchEntries,
	}
}

// normalized fills zero values with defaults, leaving LimitsDisabled intact.
func (l MetadataLimits) normalized() MetadataLimits {
	d := DefaultMetadataLimits()
	if l.MaxValueBytes == 0 {
		l.MaxValueBytes = d.MaxValueBytes
	}
	if l.MaxEntryBytes == 0 {
		l.MaxEntryBytes = d.MaxEntryBytes
	}
	if l.MaxSnapshotBytes == 0 {
		l.MaxSnapshotBytes = d.MaxSnapshotBytes
	}
	if l.MaxDepth == 0 {
		l.MaxDepth = d.MaxDepth
	}
	if l.MaxDispatchEntries == 0 {
		l.MaxDispatchEntries = d.MaxDispatchEntries
	}
	return l
}

// ClampReport records one clamping action so the caller can publish a typed
// advisory. It carries key NAMES and byte counts only — never the offending
// content, since echoing a 3 MB string into an event or a log line just moves
// the pathology somewhere else.
type ClampReport struct {
	AgentName     string
	Scope         string // "value" | "entry" | "snapshot"
	ClampedKeys   []string
	DroppedKeys   []string
	OriginalBytes int
	ClampedBytes  int
	LimitBytes    int
}

// clampStates bounds every entry in states in place and returns the reports.
func clampStates(states []types.AgentStateUpdate, limits MetadataLimits) []ClampReport {
	l := limits.normalized()
	var reports []ClampReport

	for i := range states {
		if rep := clampEntry(&states[i], l); rep != nil {
			reports = append(reports, *rep)
		}
	}

	if rep := clampSnapshot(states, l); rep != nil {
		reports = append(reports, *rep)
	}
	return reports
}

// clampEntry bounds a single agent's metadata: dispatch-history retention,
// then every value, then the entry as a whole. When the entry budget is
// enabled, approxMapBytes(entry) ≤ MaxEntryBytes holds unconditionally on
// return — the three-phase budget (drop unprotected, shrink protected
// collections, replace protected values) ends in a guarantee, not a hope.
func clampEntry(state *types.AgentStateUpdate, l MetadataLimits) *ClampReport {
	if state.Metadata == nil {
		return nil
	}

	rep := ClampReport{AgentName: state.Name, Scope: "value", LimitBytes: l.MaxValueBytes}
	originalBytes := approxMapBytes(state.Metadata)

	if capDispatches(state.Metadata, l.MaxDispatchEntries) {
		rep.ClampedKeys = append(rep.ClampedKeys, "dispatches")
	}

	if l.MaxValueBytes != LimitsDisabled {
		for _, key := range sortedKeys(state.Metadata) {
			if clamped := clampValue(state.Metadata, key, l, 0); clamped {
				rep.ClampedKeys = appendUnique(rep.ClampedKeys, key)
			}
		}
	}

	if l.MaxEntryBytes != LimitsDisabled {
		// Phase A: drop unprotected keys, largest first.
		dropped := enforceEntryBudget(state.Metadata, l.MaxEntryBytes)
		// Phase B: shrink protected collection values (dispatches[] et al.).
		shrunk := shrinkProtectedCollections(state.Metadata, l.MaxEntryBytes)
		// Phase C: replace protected values with markers until the bound holds.
		shrunk = append(shrunk, enforceProtectedGuarantee(state.Metadata, l.MaxEntryBytes)...)
		if len(dropped) > 0 || len(shrunk) > 0 {
			rep.Scope = "entry"
			rep.LimitBytes = l.MaxEntryBytes
			rep.DroppedKeys = dropped
			rep.ClampedKeys = appendUnique(rep.ClampedKeys, shrunk...)
		}
	}

	if len(rep.ClampedKeys) == 0 && len(rep.DroppedKeys) == 0 {
		return nil
	}

	markTruncated(state.Metadata, append(append([]string{}, rep.ClampedKeys...), rep.DroppedKeys...))
	if l.MaxEntryBytes != LimitsDisabled {
		// The in-band truncation stamps add a few bytes of their own; the
		// entry bound is a guarantee, so re-assert it after stamping.
		rep.ClampedKeys = appendUnique(rep.ClampedKeys, enforceProtectedGuarantee(state.Metadata, l.MaxEntryBytes)...)
	}
	rep.OriginalBytes = originalBytes
	rep.ClampedBytes = approxMapBytes(state.Metadata)
	utils.LogWithFields(utils.LevelWarn, "session.agents", "agent_metadata_clamped", map[string]any{
		"agent": state.Name, "scope": rep.Scope, "clamped_keys": rep.ClampedKeys,
		"dropped_keys": rep.DroppedKeys, "original_bytes": rep.OriginalBytes,
		"clamped_bytes": rep.ClampedBytes, "limit_bytes": rep.LimitBytes,
	})
	return &rep
}

// clampValue bounds one value in place, recursing into nested containers.
// Reports whether anything changed.
func clampValue(container map[string]any, key string, l MetadataLimits, depth int) bool {
	// Routing identity must remain exact and type-stable. A malformed giant id
	// can exceed a configured byte target, but replacing it makes durable state
	// unreachable, which is worse than an over-budget on-demand projection.
	if immutableIdentityKey(key) {
		return false
	}
	switch v := container[key].(type) {
	case string:
		if len(v) <= l.MaxValueBytes {
			return false
		}
		container[key] = truncateUTF8(v, l.MaxValueBytes)
		return true

	case map[string]any:
		if depth >= l.MaxDepth {
			container[key] = "[omitted: max depth]"
			return true
		}
		changed := false
		for _, k := range sortedKeys(v) {
			if clampValue(v, k, l, depth+1) {
				changed = true
			}
		}
		return changed

	case []any:
		// dispatches[] lives here. It is recursed into rather than dropped:
		// consumers key per-dispatch UI state on id / status / conversationId
		// inside these entries, so discarding the array collapses same-name
		// dispatches into one row.
		if depth >= l.MaxDepth {
			container[key] = "[omitted: max depth]"
			return true
		}
		changed := false
		for i, item := range v {
			switch elem := item.(type) {
			case string:
				if len(elem) > l.MaxValueBytes {
					v[i] = truncateUTF8(elem, l.MaxValueBytes)
					changed = true
				}
			case map[string]any:
				for _, k := range sortedKeys(elem) {
					if clampValue(elem, k, l, depth+1) {
						changed = true
					}
				}
			}
		}
		return changed
	}
	// Numbers, bools, and nil are inherently bounded.
	return false
}

// immutableIdentityKey identifies top-level and dispatch-entry keys clients and
// engine lifecycle code use as lookup addresses. These must never be shortened
// or marker-replaced by an outbound projection.
func immutableIdentityKey(key string) bool {
	switch key {
	case "id", "conversationId", "status", "dispatchId", "dispatchParentId", "dispatchDepth",
		"type", "visibility", "invited":
		return true
	default:
		return false
	}
}

// enforceEntryBudget drops unprotected keys, largest first, until the entry
// fits. Returns the dropped key names.
//
// Protected keys are never dropped even when the entry still exceeds budget
// afterwards: a row that renders with a stale-but-present label beats a row
// the consumer cannot identify or display at all.
func enforceEntryBudget(md map[string]any, budget int) []string {
	if approxMapBytes(md) <= budget {
		return nil
	}

	type sized struct {
		key   string
		bytes int
	}
	var candidates []sized
	for _, k := range sortedKeys(md) {
		if protectedKeys[k] || strings.HasPrefix(k, "_") {
			continue
		}
		candidates = append(candidates, sized{k, approxValueBytes(md[k])})
	}
	// Largest first: drop the fewest keys needed to fit.
	for i := 0; i < len(candidates); i++ {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].bytes > candidates[i].bytes {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}

	var dropped []string
	for _, c := range candidates {
		if approxMapBytes(md) <= budget {
			break
		}
		delete(md, c.key)
		dropped = append(dropped, c.key)
	}
	return dropped
}

// clampSnapshot enforces the whole-roster budget by dropping unprotected keys
// across the largest entries. It never removes an agent from the snapshot:
// the event is a complete snapshot applied by replacement, so omitting an
// agent tells every consumer that agent is gone.
func clampSnapshot(states []types.AgentStateUpdate, l MetadataLimits) *ClampReport {
	if l.MaxSnapshotBytes == LimitsDisabled {
		return nil
	}
	total := 0
	for i := range states {
		total += approxMapBytes(states[i].Metadata) + len(states[i].Name) + len(states[i].ID) + len(states[i].Status)
	}
	if total <= l.MaxSnapshotBytes {
		return nil
	}

	original := total
	var dropped []string
	for i := range states {
		if total <= l.MaxSnapshotBytes {
			break
		}
		before := approxMapBytes(states[i].Metadata)
		keys := enforceEntryBudget(states[i].Metadata, 0) // shed everything unprotected
		if len(keys) > 0 {
			markTruncated(states[i].Metadata, keys)
			dropped = append(dropped, keys...)
			total -= before - approxMapBytes(states[i].Metadata)
		}
	}

	// Shedding unprotected keys alone cannot enforce the bound when the mass
	// sits under protected keys (the dispatches[] pathology). Re-clamp every
	// entry against a proportional share of the roster budget — the same
	// guarantee pipeline as clampEntry, so the roster bound is as hard as the
	// entry bound. The floor keeps identity keys renderable when the roster is
	// implausibly wide; below it the byte bound yields to "every agent stays
	// identifiable", which is the documented never-drop-an-agent contract.
	if total > l.MaxSnapshotBytes {
		identityBytes := 0
		for i := range states {
			identityBytes += len(states[i].Name) + len(states[i].ID) + len(states[i].Status)
		}
		perEntry := (l.MaxSnapshotBytes - identityBytes) / len(states)
		const perEntryFloor = 1024
		if perEntry < perEntryFloor {
			perEntry = perEntryFloor
		}
		for i := range states {
			md := states[i].Metadata
			if md == nil || approxMapBytes(md) <= perEntry {
				continue
			}
			shrunk := shrinkProtectedCollections(md, perEntry)
			shrunk = append(shrunk, enforceProtectedGuarantee(md, perEntry)...)
			if len(shrunk) > 0 {
				markTruncated(md, shrunk)
				dropped = append(dropped, shrunk...)
				// Re-assert after stamping, as in clampEntry.
				enforceProtectedGuarantee(md, perEntry)
			}
		}
		total = 0
		for i := range states {
			total += approxMapBytes(states[i].Metadata) + len(states[i].Name) + len(states[i].ID) + len(states[i].Status)
		}
	}

	rep := &ClampReport{
		Scope: "snapshot", DroppedKeys: dropped,
		OriginalBytes: original, ClampedBytes: total, LimitBytes: l.MaxSnapshotBytes,
	}
	utils.LogWithFields(utils.LevelWarn, "session.agents", "agent_snapshot_clamped", map[string]any{
		"agents": len(states), "dropped_keys": len(dropped),
		"original_bytes": original, "clamped_bytes": total, "limit_bytes": l.MaxSnapshotBytes,
	})
	return rep
}

// markTruncated stamps the in-band signal that this entry was modified.
//
// This is deliberately in-band as well as carried by the typed advisory
// event. The advisory says "a clamp happened in this session"; the marker
// says "THIS value, on THIS agent, in THIS snapshot, is not what the producer
// wrote" — which is what a consumer needs to render an ellipsis or a tooltip.
// Correlating an out-of-band event back to one field of one agent inside one
// snapshot is not reliably possible, so the two are not redundant.
func markTruncated(md map[string]any, keys []string) {
	if md == nil || len(keys) == 0 {
		return
	}
	md["_truncated"] = true
	// A non-[]string value (impossible from this file, conceivable from a
	// producer squatting on the reserved key) resets to a fresh list.
	existing, ok := md["_truncatedKeys"].([]string)
	if !ok {
		existing = nil
	}
	md["_truncatedKeys"] = appendUnique(existing, keys...)
}

func appendUnique(dst []string, add ...string) []string {
	seen := make(map[string]bool, len(dst))
	for _, s := range dst {
		seen[s] = true
	}
	for _, s := range add {
		if !seen[s] {
			seen[s] = true
			dst = append(dst, s)
		}
	}
	return dst
}

// truncateUTF8 cuts s to at most maxBytes without splitting a rune.
//
// A byte slice would corrupt the payload rather than shorten it: invalid
// UTF-8 makes the whole JSON frame undecodable for a strict consumer, so the
// clamp would turn a large-but-readable snapshot into no snapshot at all.
func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	budget := maxBytes - len(truncationSuffix)
	if budget <= 0 {
		return safeCutUTF8(s, maxBytes)
	}
	return safeCutUTF8(s, budget) + truncationSuffix
}

func safeCutUTF8(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if n >= len(s) {
		return s
	}
	cut := s[:n]
	for len(cut) > 0 {
		if r, size := utf8.DecodeLastRuneInString(cut); r != utf8.RuneError || size > 1 {
			break
		}
		cut = cut[:len(cut)-1]
	}
	return cut
}

// approxValueBytes estimates a value's serialized size. Approximate is
// deliberate: an exact json.Marshal of every value on every ingest would cost
// more than the bound saves, and the tiers are coarse ceilings, not budgets
// anyone reconciles to the byte.
func approxValueBytes(v any) int {
	switch t := v.(type) {
	case string:
		return len(t) + 2
	case map[string]any:
		return approxMapBytes(t)
	case []any:
		n := 2
		for _, item := range t {
			n += approxValueBytes(item) + 1
		}
		return n
	case nil:
		return 4
	default:
		// Numbers and bools serialize short and bounded.
		return 8
	}
}

func approxMapBytes(md map[string]any) int {
	if md == nil {
		return 0
	}
	n := 2
	for k, v := range md {
		n += len(k) + 3 + approxValueBytes(v)
	}
	return n
}

// sortedKeys returns map keys in a deterministic order so clamping is
// reproducible: the same oversized payload must clamp the same way every
// time, or a test cannot pin the behavior and two engines disagree on the
// wire for identical input.
func sortedKeys(md map[string]any) []string {
	keys := make([]string, 0, len(md))
	for k := range md {
		keys = append(keys, k)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

// ClampSnapshotCopy returns a bounded emission projection without mutating the
// registry-owned source state. Metadata is an open map used by persistence and
// dispatch lifecycle updates, so byte limits apply only at the wire boundary.
func ClampSnapshotCopy(states []types.AgentStateUpdate, limits MetadataLimits) ([]types.AgentStateUpdate, []ClampReport) {
	out := make([]types.AgentStateUpdate, len(states))
	for i := range states {
		out[i] = states[i]
		out[i].Metadata = deepCopyMetadata(states[i].Metadata)
	}
	return out, clampStates(out, limits)
}

func deepCopyMetadata(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	out := make(map[string]any, len(src))
	for key, value := range src {
		out[key] = deepCopyMetadataValue(value)
	}
	return out
}

func deepCopyMetadataValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		return deepCopyMetadata(v)
	case []any:
		out := make([]any, len(v))
		for i := range v {
			out[i] = deepCopyMetadataValue(v[i])
		}
		return out
	default:
		return value
	}
}
