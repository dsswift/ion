package backend

import "strings"

// transientPrompt carries system additions through backends without a system
// prompt channel. Prefix is per run, including resumed sessions, so context is
// neither persisted as backend configuration nor lost on resume.
func transientPrompt(prompt, system string) string {
	if strings.TrimSpace(system) == "" {
		return prompt
	}
	return "<system-reminder>\n" + system + "\n</system-reminder>\n\n" + prompt
}
