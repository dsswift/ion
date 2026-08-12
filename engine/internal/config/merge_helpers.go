package config

// unionBashCommands merges two plan-mode Bash allowlists, preserving order and
// dropping duplicates. Entries from base come first (the lower-precedence
// layer), then any entry from add that base did not already contain.
//
// Order is stable rather than sorted so the resolved list reads the way the
// operator wrote it: their global entries, then whatever the project added.
// The gate that consumes this list does prefix matching, and prefix matching
// is order-independent, so ordering is a readability property (log lines,
// system-prompt prose) rather than a semantic one.
//
// Duplicate collapsing matters because both layers legitimately name common
// commands (git log, ls). Without it the resolved list, which is echoed into
// the plan-mode system prompt, would repeat entries back to the model.
func unionBashCommands(base, add []string) []string {
	seen := make(map[string]struct{}, len(base)+len(add))
	out := make([]string, 0, len(base)+len(add))
	for _, list := range [][]string{base, add} {
		for _, cmd := range list {
			if cmd == "" {
				continue
			}
			if _, dup := seen[cmd]; dup {
				continue
			}
			seen[cmd] = struct{}{}
			out = append(out, cmd)
		}
	}
	return out
}
