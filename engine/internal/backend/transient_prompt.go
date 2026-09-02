package backend

import "strings"

// transientPrompt prefixes a per-turn system reminder onto the user prompt for
// the delegated-CLI backends, which have no message-array seam of their own.
func transientPrompt(prompt, system string) string {
	if strings.TrimSpace(system) == "" {
		return prompt
	}
	return "<system-reminder>\n" + system + "\n</system-reminder>\n\n" + prompt
}

// gitContextPrompt prefixes formatted repository context onto a delegated-CLI
// prompt.
//
// The delegated-CLI backends (claude, codex, grok, cursor) have no provider
// message array the engine controls, so AppendGitContextMessage does not apply
// to them. They do send the user prompt fresh on every turn, which is the same
// position relative to the cache: after whatever prefix the CLI has cached.
// Carrying git context on the prompt therefore preserves both properties that
// matter — the model still sees current repository state every turn, and the
// volatile bytes stay out of the CLI's cached system prompt.
//
// Returns prompt unchanged when the run carries no git context.
func gitContextPrompt(prompt, gitContext string) string {
	if strings.TrimSpace(gitContext) == "" {
		return prompt
	}
	return "<system-reminder>\nCurrent repository state for this turn:\n\n" + gitContext + "\n</system-reminder>\n\n" + prompt
}
