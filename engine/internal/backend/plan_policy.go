package backend

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/tools"
)

// plan_policy.go — the single decision of whether one tool call may run while
// a run is planning.
//
// Plan mode is read-only apart from the session's plan file. That boundary is
// enforced here, at the moment a tool is called, rather than by withholding
// tools from the model: the tool list a provider receives is part of its
// prompt-cache key, so a list that changes with the mode discards the cache on
// every switch. The list stays fixed and this policy does the refusing.
//
// The policy is pure. It reads no run state and performs no I/O, so every rail
// that enforces plan mode (the API runloop, the delegated-CLI hook server, the
// engine's MCP tool server) reaches the same verdict from the same inputs.

// planVerdict is the outcome of a plan-policy decision.
type planVerdict int

const (
	// planAllow lets the call run unchanged.
	planAllow planVerdict = iota
	// planDeny refuses the call; PlanDecision.Reason is the model-facing text.
	planDeny
	// planRedirect lets a Write/Edit run against the canonical plan file
	// instead of the plan-shaped path the model named.
	planRedirect
)

// PlanDecision is what PlanPolicy.Decide returns.
type PlanDecision struct {
	Verdict planVerdict
	// Rule names the branch that decided, for logs.
	Rule string
	// Reason is the model-facing refusal text. Set only on planDeny.
	Reason string
	// RedirectPath is the canonical plan file. Set only on planRedirect.
	RedirectPath string
	// Notice is appended to the tool result after a redirected write succeeds.
	Notice string
	// PlanFileWrite reports that the call writes the canonical plan file,
	// directly or by redirect.
	PlanFileWrite bool
}

// Denied reports whether the decision refuses the call.
func (d PlanDecision) Denied() bool { return d.Verdict == planDeny }

// PlanPolicy holds the inputs of a plan-mode decision.
type PlanPolicy struct {
	// AllowedTools is the read-only tool set: the harness-supplied list, or
	// defaultPlanModeTools when the harness supplied none.
	AllowedTools []string
	// PlanSafe reports whether a tool declares itself callable in plan mode.
	// May be nil.
	PlanSafe func(name string) bool
	// BashAllowlist is the set of command prefixes Bash may run. Empty means
	// Bash is refused outright.
	BashAllowlist []string
	// McpAllowlist names the mcp__ tools (or server prefixes) allowed.
	McpAllowlist []string
	// PlanFilePath is the one writable file. Empty when the run has none.
	PlanFilePath string
	// Cwd resolves the recognized plans directories for the plan-shaped test.
	Cwd string
}

// Decide returns the verdict for one call to toolName with input.
func (p PlanPolicy) Decide(toolName string, input map[string]any) PlanDecision {
	switch toolName {
	case tools.ExitPlanModeName, tools.EnterPlanModeName, tools.AskUserQuestionName:
		// Engine sentinels. Each is intercepted by its own handler, which owns
		// the answer the model gets.
		return PlanDecision{Verdict: planAllow, Rule: "sentinel"}
	case "Write", "Edit":
		return p.decideWrite(toolName, input)
	case "Bash", "bash":
		return p.decideBash(input)
	case "Poll":
		// Poll starts a permissive evidence collector that may run Bash under
		// normal permissions. It is never a plan-mode tool, whatever a custom
		// tool list or a PlanModeSafe flag says.
		return PlanDecision{Verdict: planDeny, Rule: "poll", Reason: p.denyReason(toolName)}
	}

	for _, allowed := range p.AllowedTools {
		if allowed == toolName {
			return PlanDecision{Verdict: planAllow, Rule: "allowed_tool"}
		}
	}
	if p.PlanSafe != nil && p.PlanSafe(toolName) {
		return PlanDecision{Verdict: planAllow, Rule: "plan_mode_safe"}
	}
	if strings.HasPrefix(toolName, "mcp__") && mcpToolAllowed(toolName, p.McpAllowlist) {
		return PlanDecision{Verdict: planAllow, Rule: "mcp_allowlist"}
	}
	return PlanDecision{Verdict: planDeny, Rule: "not_plan_tool", Reason: p.denyReason(toolName)}
}

// denyReason is the refusal for a tool that is simply not a plan-mode tool. It
// names what the model can do instead, because a refusal with no alternative is
// one the model can only retry.
func (p PlanPolicy) denyReason(toolName string) string {
	allowed := p.AllowedTools
	if len(allowed) == 0 {
		allowed = defaultPlanModeTools
	}
	return fmt.Sprintf(
		"Plan mode: %s is not available while planning, because plan mode is read-only. "+
			"Do not retry it. Read-only tools you can use: %s. "+
			"When the plan is written, call %s to present it for approval.",
		toolName, strings.Join(allowed, ", "), tools.ExitPlanModeName)
}

// decideWrite applies the plan-file rule to a Write or Edit:
//
//  1. Target is the canonical plan file: allow.
//  2. Target is a plan-shaped path inside a recognized plans directory, and a
//     canonical plan file exists to redirect to: redirect. The model invented
//     a different plan filename; the write lands on the canonical file so at
//     most one plan file per run is ever created.
//  3. Anything else: deny.
func (p PlanPolicy) decideWrite(toolName string, input map[string]any) PlanDecision {
	targetPath, ok := input["file_path"].(string)
	if !ok {
		// No usable path: let the tool report its own input error.
		return PlanDecision{Verdict: planAllow, Rule: "write_no_path"}
	}
	if filepath.Clean(targetPath) == filepath.Clean(p.PlanFilePath) {
		return PlanDecision{Verdict: planAllow, Rule: "plan_file_write", PlanFileWrite: true}
	}
	if p.PlanFilePath != "" && isPlanShapedPath(targetPath, p.Cwd) {
		return PlanDecision{
			Verdict:       planRedirect,
			Rule:          "plan_file_redirect",
			RedirectPath:  p.PlanFilePath,
			PlanFileWrite: true,
			Notice: fmt.Sprintf(
				"NOTE: %s targeted %s, which is not the plan file for this session. "+
					"The engine redirected the write to the canonical plan file (%s). "+
					"Always write the plan to that exact path; do not invent a new plan filename.",
				toolName, targetPath, p.PlanFilePath),
		}
	}
	return PlanDecision{
		Verdict: planDeny,
		Rule:    "non_plan_write",
		Reason: fmt.Sprintf(
			"Plan mode: %s targeted %q — that path is not the plan file for this session. "+
				"Do not retry with that path. Your only valid write target is %s. "+
				"Resubmit your %s call targeting that exact path.",
			toolName, targetPath, p.PlanFilePath, toolName),
	}
}

// decideBash applies the Bash allowlist. Matching is case-sensitive and
// token-based: the command's leading whitespace-delimited tokens must equal
// every token of an allowlist entry, so "gh" does not match "ghost".
func (p PlanPolicy) decideBash(input map[string]any) PlanDecision {
	if len(p.BashAllowlist) == 0 {
		return PlanDecision{
			Verdict: planDeny,
			Rule:    "bash_no_allowlist",
			Reason: "Plan mode: Bash is not available while planning, because plan mode is read-only and no Bash commands are allowed for this session. " +
				"Do not retry it. Use the read-only tools to explore, then call " + tools.ExitPlanModeName + " when the plan is written.",
		}
	}
	cmd, ok := input["command"].(string)
	if !ok {
		// No usable command: let the tool report its own input error.
		return PlanDecision{Verdict: planAllow, Rule: "bash_no_command"}
	}
	if planBashCommandAllowed(cmd, p.BashAllowlist) {
		return PlanDecision{Verdict: planAllow, Rule: "bash_allowlist"}
	}
	return PlanDecision{
		Verdict: planDeny,
		Rule:    "bash_not_allowed",
		Reason:  fmt.Sprintf("Plan mode: Bash command %q is not in the allowed list. Allowed command prefixes: %v", strings.TrimSpace(cmd), p.BashAllowlist),
	}
}

// planBashCommandAllowed reports whether cmd starts with every token of some
// allowlist entry.
func planBashCommandAllowed(cmd string, allowlist []string) bool {
	cmdTokens := strings.Fields(strings.TrimSpace(cmd))
	for _, prefix := range allowlist {
		prefixTokens := strings.Fields(prefix)
		if len(cmdTokens) < len(prefixTokens) {
			continue
		}
		match := true
		for j, pt := range prefixTokens {
			if cmdTokens[j] != pt {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
