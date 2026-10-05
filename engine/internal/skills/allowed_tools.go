package skills

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// pathTools are the tools whose `Tool(pattern)` form names a path, not a
// command. Every other tool's pattern is matched against its command input.
var pathTools = map[string]bool{
	"Read": true, "Write": true, "Edit": true, "MultiEdit": true,
	"Glob": true, "Grep": true, "NotebookEdit": true, "LS": true,
}

// ParseAllowedTools turns `allowed-tools` frontmatter values into permission
// grants. Each value may hold several entries separated by commas, spaces, or
// newlines; a space inside parentheses belongs to the pattern, so
// `Bash(git add *) Bash(git commit *)` is two entries.
//
//	Bash(git add *)  -> {Tool: "Bash", CommandPatterns: ["git add *"]}
//	Read(docs/**)    -> {Tool: "Read", PathPatterns: ["docs/**"]}
//	Read             -> {Tool: "Read"}
//
// skillDir replaces ${ION_SKILL_DIR} and ${CLAUDE_SKILL_DIR} inside patterns,
// so a grant can name the skill's own scripts.
func ParseAllowedTools(values []string, skillDir string) []types.PermissionRule {
	var rules []types.PermissionRule
	for _, v := range values {
		for _, entry := range splitToolEntries(v) {
			entry = expandSkillDir(entry, skillDir)
			open := strings.Index(entry, "(")
			if open < 0 || !strings.HasSuffix(entry, ")") {
				rules = append(rules, types.PermissionRule{Tool: entry, Decision: "allow"})
				continue
			}
			tool := strings.TrimSpace(entry[:open])
			pattern := strings.TrimSpace(entry[open+1 : len(entry)-1])
			rule := types.PermissionRule{Tool: tool, Decision: "allow"}
			if pattern != "" {
				if pathTools[tool] {
					rule.PathPatterns = []string{pattern}
				} else {
					rule.CommandPatterns = []string{pattern}
				}
			}
			rules = append(rules, rule)
		}
	}
	return rules
}

// splitToolEntries splits on commas and whitespace outside parentheses.
func splitToolEntries(s string) []string {
	var out []string
	var cur strings.Builder
	depth := 0
	flush := func() {
		// A bare "-" is a YAML list marker, not an entry.
		if t := strings.TrimSpace(cur.String()); t != "" && t != "-" {
			out = append(out, t)
		}
		cur.Reset()
	}
	for _, r := range s {
		switch {
		case r == '(':
			depth++
			cur.WriteRune(r)
		case r == ')':
			if depth > 0 {
				depth--
			}
			cur.WriteRune(r)
		case depth == 0 && (r == ',' || r == ' ' || r == '\t' || r == '\n'):
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

// expandSkillDir substitutes the skill-directory placeholders. Both spellings
// are honored so a skill written for Claude Code runs unchanged.
func expandSkillDir(s, skillDir string) string {
	s = strings.ReplaceAll(s, "${ION_SKILL_DIR}", skillDir)
	return strings.ReplaceAll(s, "${CLAUDE_SKILL_DIR}", skillDir)
}
