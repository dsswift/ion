package session

// Client-tool runtime — the session-owned, backend-neutral form of the
// client's ToolGateConfig.ClientTools declaration, built once per run at
// dispatch and carried on internal RunOptions fields (json:"-").
//
// Why this exists: client tools must behave identically no matter which
// backend serves the run. The API runloop consumes tools through RunConfig;
// claude-code and the ACP backends consume them through the per-session
// ToolServer's MCP bridge; codex consumes them as thread/start dynamicTools.
// Building the filtered definition set, the fulfillment router, and the
// declaration signature ONCE here — instead of once per adapter — is what
// keeps those transports from drifting (different filtering, different
// timeout behavior, different collision rules).
//
// The declaration itself is session state (EngineConfig.ToolGate), replaced
// wholesale by an idempotent start_session; a run captures the declaration
// current at ITS dispatch and keeps it for the run's lifetime, so a reconnect
// that re-declares tools never mutates an in-flight call.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const clientToolValidationDiagnosticLimit = 200

func boundedClientToolValidationDiagnostic(err error) string {
	if err == nil {
		return ""
	}
	diagnostic := err.Error()
	if len(diagnostic) > clientToolValidationDiagnosticLimit {
		return diagnostic[:clientToolValidationDiagnosticLimit]
	}
	return diagnostic
}

// buildClientToolRuntime filters the session's client-tool declaration for
// the current run and installs the definitions, router, and signature on
// opts. No-op (all three left zero) when the session declared no client
// tools — the universal fast path.
//
// Filtering applied here, before any backend adapter sees the set:
//   - empty names (invalid declaration entries)
//   - plan-mode safety: a plan-mode run drops tools not marked PlanModeSafe
//   - AllowedTools (when non-nil, the run's allowlist) and SuppressTools
//
// Collision handling with extension/MCP tools deliberately stays at each
// adapter seam (wireClientTools for API, the ToolServer registration for
// CLI): the competing tool set is only known there, and the rule — a client
// tool never shadows an earlier registration — needs that context.
func (m *Manager) buildClientToolRuntime(s *engineSession, key string, opts *types.RunOptions) {
	gateCfg := s.config.ToolGate
	if gateCfg == nil || !gateCfg.Enabled || len(gateCfg.ClientTools) == 0 {
		return
	}

	suppressed := make(map[string]bool, len(opts.SuppressTools))
	for _, t := range opts.SuppressTools {
		suppressed[t] = true
	}
	var allowed map[string]bool
	if opts.AllowedTools != nil {
		allowed = make(map[string]bool, len(opts.AllowedTools))
		for _, t := range opts.AllowedTools {
			allowed[t] = true
		}
	}

	filtered := make([]types.ClientToolDef, 0, len(gateCfg.ClientTools))
	var droppedPlanMode, droppedPolicy int
	for _, ct := range gateCfg.ClientTools {
		if ct.Name == "" {
			utils.LogWithFields(utils.LevelWarn, "session.toolgate", "client tool with empty name skipped", map[string]any{"key": key})
			continue
		}
		if opts.PlanMode && !ct.PlanModeSafe {
			droppedPlanMode++
			continue
		}
		if suppressed[ct.Name] || (allowed != nil && !allowed[ct.Name]) {
			droppedPolicy++
			continue
		}
		filtered = append(filtered, ct)
	}
	if len(filtered) == 0 {
		utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool runtime empty after filtering", map[string]any{
			"key": key, "declared": len(gateCfg.ClientTools), "dropped_plan_mode": droppedPlanMode, "dropped_policy": droppedPolicy,
		})
		return
	}

	// Capture the declaration for the router closure: the run keeps THIS
	// config even if a later start_session replaces s.config.ToolGate.
	captured := gateCfg
	defsByName := make(map[string]types.ClientToolDef, len(filtered))
	validatorsByName := make(map[string]func(map[string]interface{}) error, len(filtered))
	for _, ct := range filtered {
		defsByName[ct.Name] = ct
		validatorsByName[ct.Name] = backend.CompileClientToolInputValidator(ct.InputSchema)
	}

	opts.ClientTools = filtered
	opts.ClientToolRouter = func(ctx context.Context, name string, input map[string]interface{}) *types.ToolResult {
		def, ok := defsByName[name]
		if !ok {
			// Defensive: adapters only route declared names here, so a miss
			// is a wiring bug worth a loud log, not a silent hang.
			utils.LogWithFields(utils.LevelError, "session.toolgate", "client tool router called for undeclared tool", map[string]any{"key": key, "tool": name})
			return &types.ToolResult{Content: "client tool " + name + " is not declared for this run", IsError: true}
		}
		if err := validatorsByName[name](input); err != nil {
			diagnostic := boundedClientToolValidationDiagnostic(err)
			utils.LogWithFields(utils.LevelWarn, "session.toolgate", "client tool input validation failed before routing", map[string]any{
				"key": key, "tool": name, "error": diagnostic,
			})
			return &types.ToolResult{Content: fmt.Sprintf("Invalid input for client tool %q: %s", name, diagnostic), IsError: true}
		}
		return m.requestClientToolResult(ctx, key, captured, def, input, s.config.WorkingDirectory, types.GateOriginModel)
	}
	// The signature covers only the MACHINE tools: human-wait tools are never
	// declared on a native session (they park the engine-owned loop instead),
	// so including them would churn codex resume cursors for a tool set the
	// thread never sees.
	machineTools := make([]types.ClientToolDef, 0, len(filtered))
	for _, ct := range filtered {
		if !ct.HumanWait {
			machineTools = append(machineTools, ct)
		}
	}
	opts.ClientToolSignature = clientToolSignature(machineTools)

	utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool runtime built", map[string]any{
		"key": key, "count": len(filtered), "dropped_plan_mode": droppedPlanMode, "dropped_policy": droppedPolicy,
		"signature": opts.ClientToolSignature,
	})
}

// clientToolSignature computes a stable digest of the effective client-tool
// set (names, schemas, and flags). Backends whose native session fixes the
// tool set at creation (codex thread/start dynamicTools) record it on their
// resume cursor; a mismatch invalidates the cursor so a resumed native
// session can never silently lack a newly declared tool. Order-insensitive:
// the defs are sorted by name before hashing so declaration order cannot
// churn cursors.
func clientToolSignature(defs []types.ClientToolDef) string {
	sorted := make([]types.ClientToolDef, len(defs))
	copy(sorted, defs)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	data, err := json.Marshal(sorted)
	if err != nil {
		// Marshal of plain structs + map[string]any schemas cannot fail in
		// practice; if it somehow does, an empty signature (treated as "no
		// tools") is the safe direction — it invalidates rather than
		// falsely validates a cursor.
		utils.LogWithFields(utils.LevelError, "session.toolgate", "client tool signature marshal failed", map[string]any{"error": err.Error()})
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
