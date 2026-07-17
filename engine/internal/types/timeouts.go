package types

import (
	"context"
	"time"
)

// TimeoutsConfig allows harness engineers to override the engine's default
// timeouts and retry limits via ion.json. Every field uses milliseconds
// (except TruncationRetries) and a zero value means "use the compiled default".
// The struct is nil-safe: all accessors accept a nil receiver and return the
// hardcoded default.
type TimeoutsConfig struct {
	ToolDefaultMs  int64 `json:"toolDefaultMs,omitempty"`  // default: 3600000 (60min)
	ToolStallMs    int64 `json:"toolStallMs,omitempty"`    // default: 30000
	BashDefaultMs  int64 `json:"bashDefaultMs,omitempty"`  // default: 120000
	McpCallMs      int64 `json:"mcpCallMs,omitempty"`      // default: 60000
	McpMetadataMs  int64 `json:"mcpMetadataMs,omitempty"`  // default: 30000
	McpWriteMs     int64 `json:"mcpWriteMs,omitempty"`     // default: 30000
	WebFetchMs     int64 `json:"webFetchMs,omitempty"`     // default: 30000
	GlobMs         int64 `json:"globMs,omitempty"`         // default: 60000
	SshDefaultMs   int64 `json:"sshDefaultMs,omitempty"`   // default: 120000
	ExtensionRpcMs int64 `json:"extensionRpcMs,omitempty"` // default: 30000
	HookDefaultMs  int64 `json:"hookDefaultMs,omitempty"`  // default: 30000
	// ElicitationMs is the human-wait timeout. It governs BOTH elicitation
	// requests (ctx.elicit) AND permission dialogs that block on a user
	// decision — both are "the engine is blocked waiting for a person to
	// answer". A value of 0 (or an absent field) means WAIT INDEFINITELY:
	// the engine waits until the human (or an extension that answers on the
	// human's behalf) responds, or until the wait is cancelled by session
	// teardown / run abort. This is the shipped default — a human who steps
	// away must never have their elicitation silently cancelled or their
	// permission silently denied by a wall-clock deadline. A positive value
	// opts into a finite wait, which is what headless / no-human deployments
	// want (e.g. 300000 to auto-resolve after 5 minutes). The JSON key stays
	// `elicitationMs` for wire compatibility even though its meaning now spans
	// permission dialogs too. See HumanWait() for the accessor semantics.
	//
	// Merge sentinel: because 0 means indefinite, 0 is also the "field absent"
	// value that MergeTimeouts skips. An overlay that wants to *restore*
	// indefinite waiting over a finite base value sets any NEGATIVE value
	// (e.g. -1) — it is non-zero so the merge overrides, and HumanWait() maps
	// ms <= 0 to indefinite, so -1 and 0 are equivalent at the accessor.
	ElicitationMs int64 `json:"elicitationMs,omitempty"` // default: 0 (wait indefinitely)
	// PermissionTimeoutDecision is the fail-action applied to a permission
	// dialog when — AND ONLY when — a FINITE human-wait (ElicitationMs > 0)
	// expires before the user answers. Allowed values: "deny" (default) and
	// "allow". Empty/unset → "deny" (fail closed). With the default indefinite
	// wait this field never fires, because the dialog never times out.
	// Elicitation requests have no allow/deny axis, so this field does not
	// affect them — an expired elicitation always returns cancelled=true.
	PermissionTimeoutDecision string `json:"permissionTimeoutDecision,omitempty"` // default: "deny"
	RelayWriteMs              int64  `json:"relayWriteMs,omitempty"`              // default: 10000
	BroadcastWriteMs          int64  `json:"broadcastWriteMs,omitempty"`          // default: 5000
	// RunStallMs is the threshold for the engine's run-progress watchdog.
	// When a run records no forward progress (no provider stream events,
	// no tool results, no turn boundaries) for longer than this many
	// milliseconds, the watchdog cancels the run's context as a safety
	// backstop and emits RunStalledEvent + a non-zero TaskCompleteEvent.
	// This is the engine's last line of defense against subsystems that
	// block indefinitely on a channel or syscall outside the reach of
	// HTTP/2 pings or per-tool timeouts. The default is generous (10min)
	// because tool execution can legitimately take minutes; harnesses
	// that orchestrate dispatched agents in parallel may want to tighten
	// this so a wedged background dispatch doesn't sit invisibly for
	// the full default. Zero (the default) means "use the compiled
	// default 600000 (10min)" via the standard nil-safe accessor below.
	RunStallMs int64 `json:"runStallMs,omitempty"` // default: 600000 (10min)
	// StreamIdleMs is the maximum gap allowed between two Server-Sent Events
	// while reading a provider's streaming LLM response. The shared HTTP
	// transport already caps the wait for the FIRST byte (ResponseHeaderTimeout
	// 60s) and detects a dead HTTP/2 connection (SendPingTimeout + PingTimeout),
	// but neither catches a stream that returns headers and then stops emitting
	// SSE bytes while the upstream keeps the H2 stream alive at the protocol
	// level. Such a stream blocks the provider read loop indefinitely with no
	// output and no error — the originating failure in the
	// 1782088921498-960b064fe896 incident (~7 minutes of total silence before a
	// client watchdog intervened). StreamIdleMs is the per-event deadline that
	// converts that silent stall into a fast, RETRYABLE stream error so the
	// existing WithRetry machinery re-streams transparently. The default (90s)
	// is comfortably above a normal inter-token gap yet well below both the
	// 10min RunStall backstop and the desktop's stuck-tab watchdog, so the
	// engine self-corrects before any external watchdog ever fires. Zero (the
	// default) means "use the compiled default 90000 (90s)". A negative value
	// disables the idle deadline (rely solely on transport + RunStall).
	StreamIdleMs      int64 `json:"streamIdleMs,omitempty"`      // default: 90000 (90s)
	TruncationRetries int   `json:"truncationRetries,omitempty"` // default: 3
}

func (t *TimeoutsConfig) durationOr(val int64, defaultMs int64) time.Duration {
	if t == nil || val == 0 {
		return time.Duration(defaultMs) * time.Millisecond
	}
	return time.Duration(val) * time.Millisecond
}

func (t *TimeoutsConfig) intOr(val int, defaultVal int) int {
	if t == nil || val == 0 {
		return defaultVal
	}
	return val
}

// ToolDefault returns the per-tool execution timeout (default 60min). This is
// a finite ceiling: a tool is a machine/subprocess doing work, so a runaway
// tool that ignores ctx must still be bounded. 60min is generous enough that
// legitimate long tools (large builds, multi-step agent dispatches) complete,
// while still capping a truly wedged tool.
func (t *TimeoutsConfig) ToolDefault() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ToolDefaultMs }), 3600000)
}

// ToolStall returns the stall detection threshold (default 30s).
func (t *TimeoutsConfig) ToolStall() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ToolStallMs }), 30000)
}

// BashDefault returns the default bash command timeout (default 120s).
func (t *TimeoutsConfig) BashDefault() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.BashDefaultMs }), 120000)
}

// McpCall returns the MCP tool call timeout (default 60s).
func (t *TimeoutsConfig) McpCall() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.McpCallMs }), 60000)
}

// McpMetadata returns the MCP metadata operation timeout (default 30s).
func (t *TimeoutsConfig) McpMetadata() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.McpMetadataMs }), 30000)
}

// McpWrite returns the MCP WebSocket write timeout (default 30s).
func (t *TimeoutsConfig) McpWrite() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.McpWriteMs }), 30000)
}

// WebFetch returns the web fetch request timeout (default 30s).
func (t *TimeoutsConfig) WebFetch() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.WebFetchMs }), 30000)
}

// Glob returns the glob walk timeout (default 60s).
func (t *TimeoutsConfig) Glob() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.GlobMs }), 60000)
}

// SshDefault returns the SSH command timeout (default 120s).
func (t *TimeoutsConfig) SshDefault() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.SshDefaultMs }), 120000)
}

// ExtensionRpc returns the extension RPC call timeout (default 30s).
func (t *TimeoutsConfig) ExtensionRpc() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ExtensionRpcMs }), 30000)
}

// HookDefault returns the default external hook execution timeout (default 30s).
func (t *TimeoutsConfig) HookDefault() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.HookDefaultMs }), 30000)
}

// HumanWait returns the human-wait timeout and whether it is finite. It governs
// both elicitation and permission dialogs (see TimeoutsConfig.ElicitationMs).
//
// Returns (0, false) when the field is unset/0 (a nil receiver also yields
// this) — meaning WAIT INDEFINITELY, the shipped default. Returns (d, true)
// with the configured duration when ElicitationMs is positive — a finite wait
// for headless / no-human deployments.
//
// This deliberately does NOT use durationOr: durationOr maps 0 → a compiled
// default, but here 0 means "infinite" (the opposite), so the zero case must
// be reported explicitly via the bool rather than collapsed into a duration.
func (t *TimeoutsConfig) HumanWait() (time.Duration, bool) {
	ms := t.field(func(c *TimeoutsConfig) int64 { return c.ElicitationMs })
	if ms <= 0 {
		return 0, false
	}
	return time.Duration(ms) * time.Millisecond, true
}

// PermissionTimeoutAction returns the fail-action ("deny" or "allow") for a
// permission dialog whose FINITE human-wait expired. Defaults to "deny" (fail
// closed) for a nil receiver, an unset field, or any unrecognized value. Only
// consulted when HumanWait() reports a finite timeout; with the default
// indefinite wait the dialog never times out and this is never read.
func (t *TimeoutsConfig) PermissionTimeoutAction() string {
	if t == nil {
		return "deny"
	}
	if t.PermissionTimeoutDecision == "allow" {
		return "allow"
	}
	return "deny"
}

// RelayWrite returns the relay forward write timeout (default 10s).
func (t *TimeoutsConfig) RelayWrite() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.RelayWriteMs }), 10000)
}

// BroadcastWrite returns the server broadcast write timeout (default 5s).
func (t *TimeoutsConfig) BroadcastWrite() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.BroadcastWriteMs }), 5000)
}

// RunStall returns the engine-wide run progress watchdog threshold (default 10min).
// See TimeoutsConfig.RunStallMs for the rationale and the watchdog contract.
func (t *TimeoutsConfig) RunStall() time.Duration {
	return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.RunStallMs }), 600000)
}

// StreamIdle returns the per-SSE-event idle deadline for provider streams and
// whether the deadline is enabled. See TimeoutsConfig.StreamIdleMs for the
// rationale.
//
// Returns (90s, true) for an unset field / nil receiver (the shipped default).
// Returns (d, true) for a positive override. Returns (0, false) for a NEGATIVE
// value, which explicitly disables the idle deadline — like HumanWait, the
// sign carries meaning the duration alone cannot, so the enabled-bool reports
// the disable case rather than collapsing it into a zero duration.
func (t *TimeoutsConfig) StreamIdle() (time.Duration, bool) {
	ms := t.field(func(c *TimeoutsConfig) int64 { return c.StreamIdleMs })
	if ms < 0 {
		return 0, false
	}
	if ms == 0 {
		return 90000 * time.Millisecond, true
	}
	return time.Duration(ms) * time.Millisecond, true
}

// TruncationRetryLimit returns the max consecutive truncation retries (default 3).
func (t *TimeoutsConfig) TruncationRetryLimit() int {
	return t.intOr(t.intField(func(c *TimeoutsConfig) int { return c.TruncationRetries }), 3)
}

// field extracts a field value, returning 0 for nil receiver.
func (t *TimeoutsConfig) field(fn func(*TimeoutsConfig) int64) int64 {
	if t == nil {
		return 0
	}
	return fn(t)
}

// intField extracts an int field value, returning 0 for nil receiver.
func (t *TimeoutsConfig) intField(fn func(*TimeoutsConfig) int) int {
	if t == nil {
		return 0
	}
	return fn(t)
}

// --- Context threading ---

type timeoutsKey struct{}

// WithTimeouts stores a TimeoutsConfig in the context for tool functions
// to read without changing the Execute signature.
func WithTimeouts(ctx context.Context, t *TimeoutsConfig) context.Context {
	return context.WithValue(ctx, timeoutsKey{}, t)
}

// TimeoutsFrom retrieves a TimeoutsConfig from the context. Returns nil if
// none is set (callers should use the typed accessors which are nil-safe).
func TimeoutsFrom(ctx context.Context) *TimeoutsConfig {
	t, _ := ctx.Value(timeoutsKey{}).(*TimeoutsConfig)
	return t
}

// MergeTimeouts copies non-zero fields from src into dst. Both pointers
// may be nil; returns the merged result (or nil if both are nil).
func MergeTimeouts(dst, src *TimeoutsConfig) *TimeoutsConfig {
	if src == nil {
		return dst
	}
	if dst == nil {
		dup := *src
		return &dup
	}
	if src.ToolDefaultMs != 0 {
		dst.ToolDefaultMs = src.ToolDefaultMs
	}
	if src.ToolStallMs != 0 {
		dst.ToolStallMs = src.ToolStallMs
	}
	if src.BashDefaultMs != 0 {
		dst.BashDefaultMs = src.BashDefaultMs
	}
	if src.McpCallMs != 0 {
		dst.McpCallMs = src.McpCallMs
	}
	if src.McpMetadataMs != 0 {
		dst.McpMetadataMs = src.McpMetadataMs
	}
	if src.McpWriteMs != 0 {
		dst.McpWriteMs = src.McpWriteMs
	}
	if src.WebFetchMs != 0 {
		dst.WebFetchMs = src.WebFetchMs
	}
	if src.GlobMs != 0 {
		dst.GlobMs = src.GlobMs
	}
	if src.SshDefaultMs != 0 {
		dst.SshDefaultMs = src.SshDefaultMs
	}
	if src.ExtensionRpcMs != 0 {
		dst.ExtensionRpcMs = src.ExtensionRpcMs
	}
	if src.HookDefaultMs != 0 {
		dst.HookDefaultMs = src.HookDefaultMs
	}
	if src.ElicitationMs != 0 {
		// ElicitationMs == 0 means "wait indefinitely" (the shipped default),
		// so 0 is also the merge-skip sentinel — an overlay that leaves the
		// field absent (0) preserves the base. To let an overlay *re-assert*
		// indefinite waiting over a finite base, use any negative value (e.g.
		// -1): it is non-zero so it overrides here, and HumanWait() already
		// maps ms <= 0 to indefinite, so the negative sentinel and a literal 0
		// behave identically at the accessor. This is the precise way to say
		// "explicitly indefinite" without a *int64 wire change.
		dst.ElicitationMs = src.ElicitationMs
	}
	if src.PermissionTimeoutDecision != "" {
		dst.PermissionTimeoutDecision = src.PermissionTimeoutDecision
	}
	if src.RelayWriteMs != 0 {
		dst.RelayWriteMs = src.RelayWriteMs
	}
	if src.BroadcastWriteMs != 0 {
		dst.BroadcastWriteMs = src.BroadcastWriteMs
	}
	if src.RunStallMs != 0 {
		dst.RunStallMs = src.RunStallMs
	}
	if src.StreamIdleMs != 0 {
		dst.StreamIdleMs = src.StreamIdleMs
	}
	if src.TruncationRetries != 0 {
		dst.TruncationRetries = src.TruncationRetries
	}
	return dst
}
