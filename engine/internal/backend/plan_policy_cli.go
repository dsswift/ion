package backend

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// plan_policy_cli.go — the plan policy as the delegated-CLI rails apply it.
//
// A delegated CLI run has two kinds of tool the engine can refuse. Its own
// native tools pass through the engine's PreToolUse hook server. The tools the
// engine bridges to it over MCP (extension tools, client tools, ion_agent, the
// engine shell, the plan-file pair) run inside the engine's ToolServer. Each
// rail asks the policy the question that fits what it can see.

// PlanPolicySource reports the plan policy for a session and whether the
// session is planning right now. A rail calls it on every tool call, so a
// session that enters plan mode part-way through a run is read-only from its
// next call, with no respawn.
type PlanPolicySource func() (policy PlanPolicy, planning bool)

// EffectivePlanBashAllowlist is the Bash allowlist a run's plan policy uses:
// the session allowlist plus this prompt's additions, clamped by enterprise
// policy.
func EffectivePlanBashAllowlist(opts types.RunOptions) []string { return effectiveBashAllowlist(opts) }

// EffectivePlanMcpAllowlist is the MCP allowlist a run's plan policy uses.
func EffectivePlanMcpAllowlist(opts types.RunOptions) []string { return effectiveMcpAllowlist(opts) }

// bridgedPlanTools are the engine-owned tools a planning model must always be
// able to reach on the MCP bridge: the two plan sentinels, the plan-file pair,
// and the question tool.
var bridgedPlanTools = map[string]bool{
	tools.ExitPlanModeName:    true,
	tools.EnterPlanModeName:   true,
	tools.AskUserQuestionName: true,
	CliWritePlanToolName:      true,
	CliEditPlanToolName:       true,
}

// bridgedToolAliases maps an MCP-bridge tool name to the name the plan-mode
// tool list knows it by.
var bridgedToolAliases = map[string]string{
	"ion_agent":        "Agent",
	"ion_agent_status": "AgentStatus",
}

// DecideBridged returns the verdict for a tool the engine bridges to a
// delegated CLI. bareName is the name it is registered under on the ToolServer,
// without the MCP server prefix.
func (p PlanPolicy) DecideBridged(bareName string, input map[string]any) PlanDecision {
	if bridgedPlanTools[bareName] {
		return PlanDecision{Verdict: planAllow, Rule: "plan_tool"}
	}
	name := bareName
	if alias, ok := bridgedToolAliases[bareName]; ok {
		name = alias
	}
	switch name {
	case "Bash":
		return p.decideBash(input)
	case "Poll":
		return PlanDecision{Verdict: planDeny, Rule: "poll", Reason: p.denyReason(bareName)}
	}
	for _, allowed := range p.AllowedTools {
		if allowed == name {
			return PlanDecision{Verdict: planAllow, Rule: "allowed_tool"}
		}
	}
	if p.PlanSafe != nil && p.PlanSafe(bareName) {
		return PlanDecision{Verdict: planAllow, Rule: "plan_mode_safe"}
	}
	if mcpToolAllowed(permissions.EngineMcpToolPrefix+bareName, p.McpAllowlist) {
		return PlanDecision{Verdict: planAllow, Rule: "mcp_allowlist"}
	}
	return PlanDecision{Verdict: planDeny, Rule: "not_plan_tool", Reason: p.denyReason(bareName)}
}

// DecideNativeCli returns the verdict for one of the delegated CLI's own
// tools, as its PreToolUse hook reports it.
//
// The CLI's file-writing tools are refused: a planning model authors its plan
// through the engine's WritePlan and EditPlan, which take no path. Bash follows
// the allowlist. Every other native tool is allowed, which is what a plan-mode
// spawn has always let through.
func (p PlanPolicy) DecideNativeCli(toolName string, input map[string]any) PlanDecision {
	switch toolName {
	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		return PlanDecision{
			Verdict: planDeny,
			Rule:    "native_write",
			Reason: fmt.Sprintf(
				"Plan mode: %s is not available while planning, because plan mode is read-only. Do not retry it. "+
					"To write your plan use %s%s (full draft) or %s%s (targeted revision); both always target this session's plan file. "+
					"When the plan is ready, call %s%s.",
				toolName,
				permissions.EngineMcpToolPrefix, CliWritePlanToolName,
				permissions.EngineMcpToolPrefix, CliEditPlanToolName,
				permissions.EngineMcpToolPrefix, tools.ExitPlanModeName),
		}
	case "Bash", "bash":
		return p.decideBash(input)
	}
	if strings.HasPrefix(toolName, permissions.EngineMcpToolPrefix) {
		// Engine-bridged: the ToolServer decides it where it executes.
		return PlanDecision{Verdict: planAllow, Rule: "bridged"}
	}
	return PlanDecision{Verdict: planAllow, Rule: "native_read"}
}
