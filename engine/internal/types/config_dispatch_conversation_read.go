package types

// DispatchConversationReadConfig bounds one page of a lineage-scoped dispatch
// conversation read (ext/read_dispatch_conversation). A caller may ask for
// less than the maximum, never more: a request above a maximum is clamped to
// it, so one large child transcript cannot be pulled in a single response.
//
// engine.json key: "dispatchConversationRead". A more specific config layer
// replaces the whole block.
type DispatchConversationReadConfig struct {
	// DefaultEntries is the page size in transcript entries when the caller
	// names none. Zero or negative means the compiled default.
	DefaultEntries int `json:"defaultEntries,omitempty"`

	// MaxEntries is the largest page size in transcript entries a caller may
	// ask for. Zero or negative means the compiled default.
	MaxEntries int `json:"maxEntries,omitempty"`

	// DefaultBytes is the serialized-byte budget of a page when the caller
	// names none. Zero or negative means the compiled default.
	DefaultBytes int `json:"defaultBytes,omitempty"`

	// MaxBytes is the largest serialized-byte budget a caller may ask for.
	// Zero or negative means the compiled default.
	MaxBytes int `json:"maxBytes,omitempty"`
}

// Compiled dispatch conversation read defaults.
const (
	DefaultDispatchConversationReadEntries    = 50
	DefaultDispatchConversationReadMaxEntries = 200
	DefaultDispatchConversationReadBytes      = 32 * 1024
	DefaultDispatchConversationReadMaxBytes   = 256 * 1024
)

// Resolved returns the effective bounds. A nil receiver yields the defaults.
// A default above its maximum is lowered to the maximum.
func (c *DispatchConversationReadConfig) Resolved() DispatchConversationReadConfig {
	out := DispatchConversationReadConfig{
		DefaultEntries: DefaultDispatchConversationReadEntries,
		MaxEntries:     DefaultDispatchConversationReadMaxEntries,
		DefaultBytes:   DefaultDispatchConversationReadBytes,
		MaxBytes:       DefaultDispatchConversationReadMaxBytes,
	}
	if c != nil {
		if c.DefaultEntries > 0 {
			out.DefaultEntries = c.DefaultEntries
		}
		if c.MaxEntries > 0 {
			out.MaxEntries = c.MaxEntries
		}
		if c.DefaultBytes > 0 {
			out.DefaultBytes = c.DefaultBytes
		}
		if c.MaxBytes > 0 {
			out.MaxBytes = c.MaxBytes
		}
	}
	out.DefaultEntries = min(out.DefaultEntries, out.MaxEntries)
	out.DefaultBytes = min(out.DefaultBytes, out.MaxBytes)
	return out
}

// Clamp returns the entry and byte budget one read runs under: the caller's
// request where it is positive, the default otherwise, never above the
// maximum. Call it on a Resolved value.
func (c DispatchConversationReadConfig) Clamp(entries, bytes int) (int, int) {
	if entries <= 0 {
		entries = c.DefaultEntries
	}
	if bytes <= 0 {
		bytes = c.DefaultBytes
	}
	return min(entries, c.MaxEntries), min(bytes, c.MaxBytes)
}
