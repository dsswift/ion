package config

import "sync"

// enforcement_recorder.go — a package-level, append-only record of enterprise
// enforcement actions taken by EnforceEnterprise (feature 0010 audit clause /
// D-018 rider #2).
//
// Why a recorder instead of emitting directly: EnforceEnterprise is a pure
// function called at config load (config.go), BEFORE any telemetry collector
// exists. It must stay pure — config does not import telemetry (and must not,
// to avoid an import cycle). So load-time enforcement actions are appended here
// and drained into the collector once telemetry initializes at serve startup
// (cmd/ion/cmd_serve.go). After that drain the serve process installs a sink
// (SetEnforcementSink), so later actions are delivered as they happen. The
// recorder is bounded so a headless library consumer that wires neither does
// not grow it without limit.

// EnforcementActionKind identifies the class of enforcement action recorded.
// It is a config-local enum: the mapping to telemetry event names lives at the
// drain site (cmd_serve), keeping this package free of a telemetry dependency.
type EnforcementActionKind string

const (
	// EnforcementProviderPruned: a non-allowlisted provider was stripped.
	EnforcementProviderPruned EnforcementActionKind = "provider_pruned"
	// EnforcementProviderPinned: an enterprise provider definition replaced
	// the user-layer definition for the same key (BaseURL/AuthHeader/Backend).
	EnforcementProviderPinned EnforcementActionKind = "provider_pinned"
	// EnforcementMcpPruned: a non-allowlisted / denied MCP server was removed.
	EnforcementMcpPruned EnforcementActionKind = "mcp_pruned"
	// EnforcementPlanModeBashPruned: a user- or project-layer plan-mode Bash
	// allowlist entry was stripped because the enterprise ceiling did not
	// sanction it (or blocks Bash in plan mode outright).
	EnforcementPlanModeBashPruned EnforcementActionKind = "plan_mode_bash_pruned"
	EnforcementPlanModeMcpPruned  EnforcementActionKind = "plan_mode_mcp_pruned"
	// EnforcementManagedPolicyAbsent: the installation is marked managed and
	// no machine policy resolved, so the engine is locked.
	EnforcementManagedPolicyAbsent EnforcementActionKind = "managed_policy_absent"
	// EnforcementManagedOverrideRefused: ION_ENTERPRISE_CONFIG was ignored
	// because the installation is marked managed.
	EnforcementManagedOverrideRefused EnforcementActionKind = "managed_override_refused"
	// EnforcementManagedConfigInvalid: a declared managed config file did not
	// apply, so its surface resolves to defaults and prompts are refused.
	EnforcementManagedConfigInvalid EnforcementActionKind = "managed_config_invalid"
	// EnforcementManagedConfigWriteRefused: a write to a surface the managed
	// source owns was refused before it reached disk.
	EnforcementManagedConfigWriteRefused EnforcementActionKind = "managed_config_write_refused"
)

// EnforcementAction is one recorded enforcement action. Subject names the
// affected entity (provider key, MCP server key); Source names the policy
// mechanism (allowlist/denylist/pin); Fields carries any extra correlation
// (e.g. the pinned baseURL).
type EnforcementAction struct {
	Kind    EnforcementActionKind
	Subject string
	Source  string
	Fields  map[string]any
}

// enforcementRecorderMaxActions bounds the recorder so a consumer that never
// drains it does not accumulate unbounded actions across repeated reloads.
const enforcementRecorderMaxActions = 1024

var (
	enforcementMu      sync.Mutex
	enforcementActions []EnforcementAction
	enforcementSink    func(EnforcementAction)
)

// SetEnforcementSink installs fn to receive every action recorded from now
// on, in place of buffering it. Nil restores buffering. Actions already
// buffered stay until DrainEnforcementActions takes them.
func SetEnforcementSink(fn func(EnforcementAction)) {
	enforcementMu.Lock()
	enforcementSink = fn
	enforcementMu.Unlock()
}

// recordEnforcement hands an enforcement action to the sink, or appends it
// when no sink is installed. Called only from this package; safe for
// concurrent use. When the recorder is at its cap, the oldest action is
// dropped (FIFO) so the most recent enforcement state is always retained.
func recordEnforcement(kind EnforcementActionKind, subject, source string, fields map[string]any) {
	action := EnforcementAction{Kind: kind, Subject: subject, Source: source, Fields: fields}
	enforcementMu.Lock()
	sink := enforcementSink
	if sink == nil {
		if len(enforcementActions) >= enforcementRecorderMaxActions {
			// Drop oldest to stay bounded.
			enforcementActions = enforcementActions[1:]
		}
		enforcementActions = append(enforcementActions, action)
	}
	enforcementMu.Unlock()
	if sink != nil {
		sink(action)
	}
}

// DrainEnforcementActions returns all buffered enforcement actions and clears
// the recorder. Safe for concurrent use.
func DrainEnforcementActions() []EnforcementAction {
	enforcementMu.Lock()
	defer enforcementMu.Unlock()
	if len(enforcementActions) == 0 {
		return nil
	}
	out := enforcementActions
	enforcementActions = nil
	return out
}
