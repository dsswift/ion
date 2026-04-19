// Package permissions implements the Ion Engine permission evaluation system.
// Port of engine/src/permissions/ (429 lines).
package permissions

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// Engine evaluates permission checks against a policy.
type Engine struct {
	policy     *types.PermissionPolicy
	classifier *LlmClassifier
	auditFn    func(AuditEntry)
}

// SetClassifier attaches an LLM classifier for ambiguous "ask" mode decisions.
func (e *Engine) SetClassifier(c *LlmClassifier) {
	e.classifier = c
}

// DefaultPolicy is allow-all. The engine ships security primitives (dangerous
// command patterns, sensitive path checks, secret redaction) as opt-in modules.
// Harness engineers enable enforcement by configuring a "deny" or "ask" policy.
var DefaultPolicy = types.PermissionPolicy{
	Mode: "allow",
}

// NewEngine creates a permission engine with the given policy.
// If policy is nil, a permissive allow-all policy is used. For the TS-parity
// deny-with-read-only default, pass &DefaultPolicy explicitly.
func NewEngine(policy *types.PermissionPolicy) *Engine {
	if policy == nil {
		policy = &types.PermissionPolicy{Mode: "allow"}
	}
	return &Engine{policy: policy}
}

// CheckInfo is the input to a permission evaluation.
type CheckInfo struct {
	Tool      string
	Input     map[string]interface{}
	Cwd       string
	SessionID string
}

// CheckResult is the output of a permission evaluation.
type CheckResult struct {
	Decision string // "allow", "deny"
	Reason   string
	Rule     *types.PermissionRule
}

// Check evaluates a tool invocation against the policy.
// Evaluation order:
//  1. Allow mode: skip all checks. Harness engineer opted out of engine-level enforcement.
//  2. Dangerous patterns check (bash commands only, deny/ask modes).
//  3. Sensitive path check (tools with path input).
//  4. Read-only path check (write tools).
//  5. Per-rule matching (first match wins -- rules can punch holes in deny mode).
//  6. Mode-based default: deny blocks, ask prompts user.
func (e *Engine) Check(info CheckInfo) *CheckResult {
	// In allow mode, skip all checks -- harness engineer opted out of engine-level enforcement
	if e.policy.Mode == "allow" {
		result := &CheckResult{Decision: "allow", Reason: "default allow"}
		e.audit(info, result)
		return result
	}

	// Check dangerous patterns for bash tool (deny/ask modes only)
	if info.Tool == "bash" || info.Tool == "Bash" {
		if cmd, ok := info.Input["command"].(string); ok {
			if dangerous, reason := IsDangerousCommand(cmd); dangerous {
				result := &CheckResult{
					Decision: "deny",
					Reason:   reason,
				}
				e.audit(info, result)
				return result
			}
		}
	}

	// Check sensitive paths for tools with path input
	if path, ok := extractPath(info); ok {
		if IsSensitivePath(path) {
			result := &CheckResult{
				Decision: "deny",
				Reason:   "access to sensitive path: " + path,
			}
			e.audit(info, result)
			return result
		}
	}

	// Check read-only paths for write operations
	if isWriteTool(info.Tool) {
		if path, ok := extractPath(info); ok {
			for _, roPath := range e.policy.ReadOnlyPaths {
				if MatchPattern(roPath, path) {
					result := &CheckResult{
						Decision: "deny",
						Reason:   "path is read-only: " + path,
					}
					e.audit(info, result)
					return result
				}
			}
		}
	}

	// Evaluate explicit rules (first match wins -- allows rules to punch holes in deny mode)
	for i := range e.policy.Rules {
		rule := &e.policy.Rules[i]
		if !matchTool(rule.Tool, info.Tool) {
			continue
		}
		if matchRule(rule, info) {
			result := &CheckResult{
				Decision: rule.Decision,
				Reason:   "matched rule for " + rule.Tool,
				Rule:     rule,
			}
			e.audit(info, result)
			return result
		}
	}

	// Default based on mode
	var result *CheckResult
	switch e.policy.Mode {
	case "allow":
		result = &CheckResult{
			Decision: "allow",
			Reason:   "default allow",
		}
	case "ask":
		// Auto-approve safe commands in ask mode
		if info.Tool == "bash" || info.Tool == "Bash" {
			if cmd, ok := info.Input["command"].(string); ok {
				if IsSafeBashCommand(cmd) {
					result = &CheckResult{
						Decision: "allow",
						Reason:   "safe command auto-approved",
					}
					e.audit(info, result)
					return result
				}
				// G01: Use LLM classifier for ambiguous bash commands
				if e.classifier != nil {
					cr := e.classifier.Classify(context.Background(), cmd)
					if cr.Decision == "allow" {
						result = &CheckResult{
							Decision: "allow",
							Reason:   "LLM classifier: " + cr.Reason,
						}
						e.audit(info, result)
						return result
					}
				}
			}
		}
		result = &CheckResult{
			Decision: "ask",
			Reason:   "requires user approval",
		}
	case "deny":
		result = &CheckResult{
			Decision: "deny",
			Reason:   "denied by default policy",
		}
	default:
		result = &CheckResult{
			Decision: "deny",
			Reason:   "unknown policy mode: " + e.policy.Mode,
		}
	}
	e.audit(info, result)
	return result
}

// AuditEntry records a permission check decision.
type AuditEntry struct {
	Tool      string
	Decision  string
	Reason    string
	Timestamp time.Time
	Input     string
	Rule      string
	SessionID string
}

// OnAudit registers a callback for permission audit logging (G48).
func (e *Engine) OnAudit(fn func(AuditEntry)) {
	e.auditFn = fn
}

func (e *Engine) audit(info CheckInfo, result *CheckResult) {
	if e.auditFn == nil {
		return
	}
	entry := AuditEntry{
		Tool:      info.Tool,
		Decision:  result.Decision,
		Reason:    result.Reason,
		Timestamp: time.Now(),
		SessionID: info.SessionID,
	}
	// Capture the raw input as the command string when available, otherwise
	// fall back to the first path-like field so the audit log is actionable.
	if cmd, ok := info.Input["command"].(string); ok {
		entry.Input = cmd
	} else {
		for _, key := range []string{"path", "file_path", "filePath", "directory"} {
			if v, ok := info.Input[key].(string); ok && v != "" {
				entry.Input = v
				break
			}
		}
	}
	if result.Rule != nil {
		entry.Rule = result.Rule.Tool
	}
	e.auditFn(entry)
}

// extractPath pulls the path from tool input, checking common field names.
func extractPath(info CheckInfo) (string, bool) {
	for _, key := range []string{"path", "file_path", "filePath", "directory"} {
		if v, ok := info.Input[key].(string); ok && v != "" {
			return v, true
		}
	}
	return "", false
}

// isWriteTool returns true for tools that modify files.
func isWriteTool(tool string) bool {
	switch tool {
	case "write", "Write", "edit", "Edit":
		return true
	}
	return false
}

// matchTool checks if a rule's tool pattern matches the given tool name.
// Supports exact match and wildcard "*".
func matchTool(pattern, tool string) bool {
	if pattern == "*" {
		return true
	}
	return pattern == tool
}

// matchRule checks if a rule's command/path patterns match the check input.
func matchRule(rule *types.PermissionRule, info CheckInfo) bool {
	// If rule has command patterns, at least one must match
	if len(rule.CommandPatterns) > 0 {
		cmd, ok := info.Input["command"].(string)
		if !ok {
			return false
		}
		matched := false
		for _, pat := range rule.CommandPatterns {
			if MatchPattern(pat, cmd) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}

	// If rule has path patterns, at least one must match
	if len(rule.PathPatterns) > 0 {
		path, ok := extractPath(info)
		if !ok {
			return false
		}
		matched := false
		for _, pat := range rule.PathPatterns {
			if MatchPattern(pat, path) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}

	return true
}
