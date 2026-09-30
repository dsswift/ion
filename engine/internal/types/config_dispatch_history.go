package types

// DispatchHistoryConfig bounds the terminal dispatch history each session's
// dispatch registry retains. When a dispatch ends it leaves the live registry
// and a terminal record (final status, reason, completion time, lineage) is
// kept, so a consumer can ask what finished without polling fast enough to
// catch every dispatch before it ends. The bound keeps that history from
// growing without limit.
//
// engine.json key: "dispatchHistory". A more specific config layer replaces
// the whole block.
type DispatchHistoryConfig struct {
	// MaxEntries caps how many terminal dispatches one session retains. The
	// oldest completions are evicted first. Zero means the compiled default;
	// a negative value turns retention off.
	MaxEntries int `json:"maxEntries,omitempty"`

	// MaxAgeMs evicts a terminal dispatch this many milliseconds after it
	// completed. Zero means the compiled default; a negative value removes the
	// age bound, leaving only MaxEntries.
	MaxAgeMs int64 `json:"maxAgeMs,omitempty"`
}

// Compiled dispatch history defaults.
const (
	DefaultDispatchHistoryMaxEntries = 200
	DefaultDispatchHistoryMaxAgeMs   = int64(60 * 60 * 1000)
)

// Resolved returns the effective bound. A nil receiver yields the defaults.
// In the result, MaxEntries <= 0 means retention is off and MaxAgeMs <= 0
// means there is no age bound.
func (c *DispatchHistoryConfig) Resolved() DispatchHistoryConfig {
	out := DispatchHistoryConfig{
		MaxEntries: DefaultDispatchHistoryMaxEntries,
		MaxAgeMs:   DefaultDispatchHistoryMaxAgeMs,
	}
	if c == nil {
		return out
	}
	if c.MaxEntries != 0 {
		out.MaxEntries = max(c.MaxEntries, 0)
	}
	if c.MaxAgeMs != 0 {
		out.MaxAgeMs = max(c.MaxAgeMs, 0)
	}
	return out
}
