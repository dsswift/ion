package types

// config_agent_state.go — operator controls for the engine_agent_state
// metadata bound.
//
// AgentStateUpdate.Metadata is an untyped map an extension fills. Because
// engine_agent_state is a complete snapshot, an oversized value is paid on
// every emission rather than once, and a single extension can wedge every
// consumer of a session. The engine therefore bounds it.
//
// The bound is a mechanism, not an opinion: what belongs in metadata is the
// consumer's business, but "one extension must not be able to make the event
// undeliverable for everyone" is the engine's. The tunables here exist so an
// operator whose workload genuinely needs larger values can raise them
// without patching the engine.

// AgentStateMetadataLimits bounds the size of agent-state metadata.
//
// All fields are pointers so engine.json can omit any subset and inherit the
// compiled default. Within a field: nil or 0 means "use the default", and -1
// disables that tier entirely.
type AgentStateMetadataLimits struct {
	// MaxValueBytes bounds a single metadata value. This is the tier that
	// catches the common failure: one enormous string (a whole command
	// output, a stack trace, a base64 blob) in an otherwise normal map.
	MaxValueBytes *int `json:"maxValueBytes,omitempty"`

	// MaxEntryBytes bounds one agent's entire metadata map after per-value
	// clamping, catching growth by many small keys rather than one big one.
	// Protected keys (displayName, visibility, invited, dispatch identity)
	// are never dropped to meet this budget — their values are clamped, but
	// removing them would leave consumers unable to label or place the row.
	MaxEntryBytes *int `json:"maxEntryBytes,omitempty"`

	// MaxSnapshotBytes bounds the whole roster, catching an agent-COUNT
	// explosion rather than per-agent bloat. The clamp never drops an agent
	// to meet this budget: the event is a complete snapshot applied by
	// replacement, so omitting an agent tells every consumer it is gone.
	MaxSnapshotBytes *int `json:"maxSnapshotBytes,omitempty"`

	// MaxDepth bounds recursion into nested maps and slices.
	MaxDepth *int `json:"maxDepth,omitempty"`
}

// ResolvedAgentStateMetadataLimits is the flattened form the engine uses.
type ResolvedAgentStateMetadataLimits struct {
	MaxValueBytes    int
	MaxEntryBytes    int
	MaxSnapshotBytes int
	MaxDepth         int
}

// Built-in defaults. Kept here so config resolution has a single source of
// truth; the agents package mirrors these as its own constants for the case
// where no config is present at all.
const (
	DefaultAgentStateMaxValueBytes    = 4096
	DefaultAgentStateMaxEntryBytes    = 65536
	DefaultAgentStateMaxSnapshotBytes = 4 * 1024 * 1024
	DefaultAgentStateMaxDepth         = 4
)

// AgentStateMetadataDefaults returns the compiled defaults.
func AgentStateMetadataDefaults() ResolvedAgentStateMetadataLimits {
	return ResolvedAgentStateMetadataLimits{
		MaxValueBytes:    DefaultAgentStateMaxValueBytes,
		MaxEntryBytes:    DefaultAgentStateMaxEntryBytes,
		MaxSnapshotBytes: DefaultAgentStateMaxSnapshotBytes,
		MaxDepth:         DefaultAgentStateMaxDepth,
	}
}

// Resolved flattens the pointer config against the compiled defaults. A nil
// receiver resolves to defaults, so callers do not need a nil check.
func (l *AgentStateMetadataLimits) Resolved() ResolvedAgentStateMetadataLimits {
	out := AgentStateMetadataDefaults()
	if l == nil {
		return out
	}
	if l.MaxValueBytes != nil && *l.MaxValueBytes != 0 {
		out.MaxValueBytes = *l.MaxValueBytes
	}
	if l.MaxEntryBytes != nil && *l.MaxEntryBytes != 0 {
		out.MaxEntryBytes = *l.MaxEntryBytes
	}
	if l.MaxSnapshotBytes != nil && *l.MaxSnapshotBytes != 0 {
		out.MaxSnapshotBytes = *l.MaxSnapshotBytes
	}
	if l.MaxDepth != nil && *l.MaxDepth != 0 {
		out.MaxDepth = *l.MaxDepth
	}
	return out
}

// EnterpriseAgentStateMetadataLimits is the enterprise-sealed ceiling. Every
// field is a MINIMUM-wins bound: a lower layer may tighten, never loosen.
type EnterpriseAgentStateMetadataLimits struct {
	MaxValueBytes    *int `json:"maxValueBytes,omitempty"`
	MaxEntryBytes    *int `json:"maxEntryBytes,omitempty"`
	MaxSnapshotBytes *int `json:"maxSnapshotBytes,omitempty"`
}

// ApplyCeiling narrows resolved limits to the enterprise ceiling.
//
// MIN semantics with one wrinkle: a tier the operator DISABLED (-1) is
// unbounded, so any enterprise ceiling is tighter and wins outright. Treating
// -1 as "smallest" numerically would have inverted that and let a local
// config switch off an enterprise bound.
func (c *EnterpriseAgentStateMetadataLimits) ApplyCeiling(r ResolvedAgentStateMetadataLimits) ResolvedAgentStateMetadataLimits {
	if c == nil {
		return r
	}
	r.MaxValueBytes = minBound(r.MaxValueBytes, c.MaxValueBytes)
	r.MaxEntryBytes = minBound(r.MaxEntryBytes, c.MaxEntryBytes)
	r.MaxSnapshotBytes = minBound(r.MaxSnapshotBytes, c.MaxSnapshotBytes)
	return r
}

// minBound returns the tighter of a current value and an optional ceiling,
// treating a disabled (-1) current value as unbounded.
func minBound(current int, ceiling *int) int {
	if ceiling == nil || *ceiling <= 0 {
		return current
	}
	if current < 0 || *ceiling < current {
		return *ceiling
	}
	return current
}
