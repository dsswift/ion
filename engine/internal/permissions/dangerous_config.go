package permissions

// checkConfiguredDangerous applies the policy's own dangerousPatterns, which
// supplement the built-in list. They are regexes searched in the full Bash
// command. Like the built-in list they are off in allow mode. A match is
// denied in deny mode and asks in ask mode, unless the first matching rule
// denies it; an allow rule never lifts it. Returns nil when no pattern
// decides the call.
func (e *Engine) checkConfiguredDangerous(info CheckInfo) *CheckResult {
	if len(e.policy.DangerousPatterns) == 0 || !IsBashToolName(info.Tool) {
		return nil
	}
	cmd, ok := info.Input["command"].(string)
	if !ok {
		return nil
	}
	for _, pat := range e.policy.DangerousPatterns {
		if !matchCommandRegex(pat, cmd) {
			continue
		}
		reason := "matches configured dangerous pattern: " + pat
		if e.policy.Mode != "ask" {
			return &CheckResult{Decision: "deny", Reason: reason, Layer: "dangerous_pattern"}
		}
		if rule := e.firstMatchingRule(info); rule != nil && rule.Decision == "deny" {
			return &CheckResult{Decision: "deny", Reason: "matched rule for " + rule.Tool, Rule: rule, Layer: "explicit_rule"}
		}
		return &CheckResult{Decision: "ask", Reason: reason, Layer: "dangerous_pattern"}
	}
	return nil
}
