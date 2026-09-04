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
