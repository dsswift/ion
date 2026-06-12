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
	ToolDefaultMs     int64 `json:"toolDefaultMs,omitempty"`     // default: 300000 (5min)
	ToolStallMs       int64 `json:"toolStallMs,omitempty"`       // default: 30000
	BashDefaultMs     int64 `json:"bashDefaultMs,omitempty"`     // default: 120000
	McpCallMs         int64 `json:"mcpCallMs,omitempty"`         // default: 60000
	McpMetadataMs     int64 `json:"mcpMetadataMs,omitempty"`     // default: 30000
	McpWriteMs        int64 `json:"mcpWriteMs,omitempty"`        // default: 30000
	WebFetchMs        int64 `json:"webFetchMs,omitempty"`        // default: 30000
	GlobMs            int64 `json:"globMs,omitempty"`            // default: 60000
	SshDefaultMs      int64 `json:"sshDefaultMs,omitempty"`      // default: 120000
	ExtensionRpcMs    int64 `json:"extensionRpcMs,omitempty"`    // default: 30000
	HookDefaultMs     int64 `json:"hookDefaultMs,omitempty"`     // default: 30000
	ElicitationMs     int64 `json:"elicitationMs,omitempty"`     // default: 300000 (5min)
	RelayWriteMs      int64 `json:"relayWriteMs,omitempty"`      // default: 10000
	BroadcastWriteMs  int64 `json:"broadcastWriteMs,omitempty"`  // default: 5000
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
	RunStallMs        int64 `json:"runStallMs,omitempty"`        // default: 600000 (10min)
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

// ToolDefault returns the per-tool execution timeout (default 5min).
func (t *TimeoutsConfig) ToolDefault() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ToolDefaultMs }), 300000) }

// ToolStall returns the stall detection threshold (default 30s).
func (t *TimeoutsConfig) ToolStall() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ToolStallMs }), 30000) }

// BashDefault returns the default bash command timeout (default 120s).
func (t *TimeoutsConfig) BashDefault() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.BashDefaultMs }), 120000) }

// McpCall returns the MCP tool call timeout (default 60s).
func (t *TimeoutsConfig) McpCall() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.McpCallMs }), 60000) }

// McpMetadata returns the MCP metadata operation timeout (default 30s).
func (t *TimeoutsConfig) McpMetadata() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.McpMetadataMs }), 30000) }

// McpWrite returns the MCP WebSocket write timeout (default 30s).
func (t *TimeoutsConfig) McpWrite() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.McpWriteMs }), 30000) }

// WebFetch returns the web fetch request timeout (default 30s).
func (t *TimeoutsConfig) WebFetch() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.WebFetchMs }), 30000) }

// Glob returns the glob walk timeout (default 60s).
func (t *TimeoutsConfig) Glob() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.GlobMs }), 60000) }

// SshDefault returns the SSH command timeout (default 120s).
func (t *TimeoutsConfig) SshDefault() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.SshDefaultMs }), 120000) }

// ExtensionRpc returns the extension RPC call timeout (default 30s).
func (t *TimeoutsConfig) ExtensionRpc() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ExtensionRpcMs }), 30000) }

// HookDefault returns the default external hook execution timeout (default 30s).
func (t *TimeoutsConfig) HookDefault() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.HookDefaultMs }), 30000) }

// Elicitation returns the elicitation wait timeout (default 5min).
func (t *TimeoutsConfig) Elicitation() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.ElicitationMs }), 300000) }

// RelayWrite returns the relay forward write timeout (default 10s).
func (t *TimeoutsConfig) RelayWrite() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.RelayWriteMs }), 10000) }

// BroadcastWrite returns the server broadcast write timeout (default 5s).
func (t *TimeoutsConfig) BroadcastWrite() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.BroadcastWriteMs }), 5000) }

// RunStall returns the engine-wide run progress watchdog threshold (default 10min).
// See TimeoutsConfig.RunStallMs for the rationale and the watchdog contract.
func (t *TimeoutsConfig) RunStall() time.Duration { return t.durationOr(t.field(func(c *TimeoutsConfig) int64 { return c.RunStallMs }), 600000) }

// TruncationRetryLimit returns the max consecutive truncation retries (default 3).
func (t *TimeoutsConfig) TruncationRetryLimit() int { return t.intOr(t.intField(func(c *TimeoutsConfig) int { return c.TruncationRetries }), 3) }

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
		dst.ElicitationMs = src.ElicitationMs
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
	if src.TruncationRetries != 0 {
		dst.TruncationRetries = src.TruncationRetries
	}
	return dst
}
