package extcontext

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/extension"
)

// dispatch_usage_suffix.go formats the usage block appended to the Agent
// tool's result content. The dispatch mechanism already computes per-dispatch
// token usage and cost (DispatchAgentResult); without this suffix the spawner
// returned only the child's output text and the numbers were dropped on the
// model-facing path.
//
// This is model-facing input, not consumer signaling: the model cannot read
// the engine_dispatch_start/end telemetry, and the tool-result content is its
// only channel. Skills and orchestration prompts that budget or account for
// subagent spend (e.g. cost trackers that record per-chunk token counts) read
// it here. Consumer-facing usage remains exclusively on the existing typed
// dispatch telemetry — nothing is added or moved there.

// FormatDispatchUsageSuffix renders the usage block for a completed dispatch,
// prefixed with a blank line so it separates from the child's output. Returns
// "" for a nil result. Zero-valued fields are still rendered (a zero count is
// honest data; omitting it would read as "unknown"), except the optional
// cache/thinking/dispatch-id fields which are omitted when zero/empty.
func FormatDispatchUsageSuffix(r *extension.DispatchAgentResult) string {
	if r == nil {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\n<usage>")
	fmt.Fprintf(&sb, "input_tokens=%d output_tokens=%d", r.InputTokens, r.OutputTokens)
	if r.CacheReadInputTokens > 0 {
		fmt.Fprintf(&sb, " cache_read_input_tokens=%d", r.CacheReadInputTokens)
	}
	if r.CacheCreationInputTokens > 0 {
		fmt.Fprintf(&sb, " cache_creation_input_tokens=%d", r.CacheCreationInputTokens)
	}
	if r.ThinkingTokens > 0 {
		fmt.Fprintf(&sb, " thinking_tokens=%d", r.ThinkingTokens)
	}
	if r.Cost > 0 {
		fmt.Fprintf(&sb, " cost_usd=%.4f", r.Cost)
	}
	if r.Elapsed > 0 {
		fmt.Fprintf(&sb, " elapsed_s=%.1f", r.Elapsed)
	}
	if r.DispatchID != "" {
		fmt.Fprintf(&sb, " dispatch_id=%s", r.DispatchID)
	}
	sb.WriteString("</usage>")
	return sb.String()
}
