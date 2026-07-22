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
// (cmd/ion/cmd_serve.go). Subsequent config reloads append again and drain on
// the next pass via the same hook. The recorder is bounded so a headless
// library consumer that never wires a drain does not grow it without limit.

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
)

// recordEnforcement appends an enforcement action. Called only from
// EnforceEnterprise (same package); safe for concurrent use. When the recorder
// is at its cap, the oldest action is dropped (FIFO) so the most recent
// enforcement state is always retained.
func recordEnforcement(kind EnforcementActionKind, subject, source string, fields map[string]any) {
	enforcementMu.Lock()
	defer enforcementMu.Unlock()
	if len(enforcementActions) >= enforcementRecorderMaxActions {
		// Drop oldest to stay bounded.
		enforcementActions = enforcementActions[1:]
	}
	enforcementActions = append(enforcementActions, EnforcementAction{
		Kind:    kind,
		Subject: subject,
		Source:  source,
		Fields:  fields,
	})
}

// DrainEnforcementActions returns all recorded enforcement actions and clears
// the recorder. Called at serve startup (and on each EnforceEnterprise reload
// pass, via the drain hook wired in cmd_serve) to emit one telemetry event per
// action. Safe for concurrent use.
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
