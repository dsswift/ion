package extcontext

import "github.com/dsswift/ion/engine/internal/utils"

// Agent-state roster visibility values. A client uses these to decide whether
// an agent row survives past the run that created it.
const (
	// VisibilitySticky keeps the row after the dispatch finishes. This is the
	// engine default for every dispatch.
	VisibilitySticky = "sticky"
	// VisibilityEphemeral drops the row the moment the dispatch is no longer
	// running. Opt-in only.
	VisibilityEphemeral = "ephemeral"
	// VisibilityAlways keeps the row unconditionally, including before the
	// agent has ever been dispatched.
	VisibilityAlways = "always"
)

// resolveDispatchVisibility maps a caller's requested visibility to the value
// stamped on the dispatch's agent-state row.
//
// The default is sticky, deliberately. A dispatched agent that vanishes from
// the roster the instant it completes cannot be inspected: an operator opening
// a finished dispatch sees no children, because the children were removed
// before the drill-down was opened. That is not a rendering bug, it is a
// default that discards the record. Persisting the row is the useful behavior
// and disappearing is the special case, so disappearing is what a caller opts
// into.
//
// An unrecognized value resolves to sticky and warns rather than failing the
// dispatch. Refusing real work over a roster-presentation string would be a
// worse outcome than showing the row for longer than a caller intended.
func resolveDispatchVisibility(requested, agentName string) string {
	switch requested {
	case "":
		return VisibilitySticky
	case VisibilitySticky, VisibilityEphemeral, VisibilityAlways:
		return requested
	default:
		utils.LogWithFields(utils.LevelWarn, "session", "unrecognized dispatch visibility; using sticky", map[string]any{
			"model": agentName, "reason": requested,
		})
		return VisibilitySticky
	}
}
