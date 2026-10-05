package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// prompt_cli_plan_policy.go — the plan policy for a delegated-CLI session.
//
// The API backend applies the policy inside its own tool loop. A delegated CLI
// runs its tools elsewhere, so the session hands the policy to the two rails
// that can refuse a call: the PreToolUse hook server for the CLI's native
// tools, and the MCP ToolServer for the tools the engine bridges to it.
//
// Both rails read the session's live plan state on every call. That is what
// makes a model that enters plan mode part-way through a run read-only from
// its next tool call, in the same subprocess.

// stageCliPlanPolicy records the plan-policy inputs for this prompt on the
// session: the allowed tool list, the allowlists including this prompt's
// additions, and how to tell whether a bridged tool declares itself plan-safe.
func (m *Manager) stageCliPlanPolicy(s *engineSession, key string, opts *types.RunOptions, extGroup *extension.ExtensionGroup) {
	if _, ok := mcpCapableCli(m.resolvedBackend(opts.Model)); !ok {
		return
	}
	allowed := opts.PlanModeTools
	source := "session"
	if len(allowed) == 0 {
		allowed = backend.DefaultPlanModeTools()
		source = "default"
	}
	gateCfg := s.config.ToolGate
	policy := backend.PlanPolicy{
		AllowedTools:  allowed,
		BashAllowlist: backend.EffectivePlanBashAllowlist(*opts),
		McpAllowlist:  backend.EffectivePlanMcpAllowlist(*opts),
		Cwd:           opts.ProjectPath,
		PlanSafe: func(name string) bool {
			if extGroup != nil {
				for _, tool := range extGroup.Tools() {
					if tool.Name == name {
						return tool.PlanModeSafe
					}
				}
			}
			if gateCfg != nil {
				for _, ct := range gateCfg.ClientTools {
					if ct.Name == name {
						// A human-wait tool ends the turn and hands off to the
						// operator; it mutates nothing.
						return ct.PlanModeSafe || ct.HumanWait
					}
				}
			}
			return false
		},
	}

	m.mu.Lock()
	s.cliPlanPolicy = policy
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "session.plan_mode", "cli plan policy staged", map[string]any{
		"key": key, "allowed_tools_source": source, "bash_allowlist": policy.BashAllowlist, "mcp_allowlist": policy.McpAllowlist,
	})
}

// cliPlanPolicySource returns the live view of the session's plan policy that
// the delegated-CLI rails consult on every tool call.
func (m *Manager) cliPlanPolicySource(s *engineSession) backend.PlanPolicySource {
	return func() (backend.PlanPolicy, bool) {
		m.mu.RLock()
		defer m.mu.RUnlock()
		policy := s.cliPlanPolicy
		policy.PlanFilePath = s.planFilePath
		return policy, s.planMode
	}
}
