package session

import (
	"regexp"
	"strconv"
	"strings"
)

// slash_frontmatter.go owns frontmatter parsing (into an open map that preserves
// unknown keys) and the $ARGUMENTS substitution engine for resolved slash
// commands. Split from slash_resolve.go to keep both files focused and under the
// file-size cap.
//
// The parser is hand-rolled rather than YAML-library-based to match the engine's
// existing frontmatter convention (agentdiscovery/frontmatter.go,
// skills/skills.go both parse `key: value` line-by-line) and to avoid adding a
// YAML dependency. It handles the shapes command/skill templates actually use:
//   - scalar:        key: value
//   - inline list:   key: [a, b, c]
//   - indented list: key:
//                      - a
//                      - b
// Every key — known or not — is preserved in the returned open map so an
// extension can read keys the engine ignores (the extensibility seam).

// parseOpenFrontmatter splits a markdown template into its frontmatter (an open
// map preserving all keys) and body. Returns an empty (non-nil) map and the full
// content as the body when there is no frontmatter fence (best-effort, matching
// the rest of the template-loading stance).
func parseOpenFrontmatter(content string) (map[string]any, string) {
	trimmed := strings.TrimLeft(content, "\r\n")
	if !strings.HasPrefix(trimmed, "---") {
		return map[string]any{}, strings.TrimSpace(content)
	}

	rest := trimmed[3:]
	rest = strings.TrimLeft(rest, "\r\n")
	idx := strings.Index(rest, "\n---")
	if idx < 0 {
		// No closing fence — treat the whole thing as body.
		return map[string]any{}, strings.TrimSpace(content)
	}

	fmBlock := rest[:idx]
	body := strings.TrimSpace(rest[idx+4:]) // skip "\n---"
	return parseFrontmatterLines(fmBlock), body
}

// parseFrontmatterLines parses the YAML-ish frontmatter block into an open map.
// A key with an immediately-following indented `- item` block becomes a
// []string; an inline `[a, b]` value becomes a []string; everything else is a
// trimmed scalar string.
func parseFrontmatterLines(block string) map[string]any {
	out := map[string]any{}
	lines := strings.Split(block, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.Index(trimmed, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:colon])
		val := strings.TrimSpace(trimmed[colon+1:])

		if val == "" {
			// Possible indented list following this key.
			items := collectIndentedList(lines, i+1)
			if len(items) > 0 {
				out[key] = items
				i += len(items)
				continue
			}
			out[key] = ""
			continue
		}
		if strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]") {
			out[key] = parseInlineList(val)
			continue
		}
		out[key] = unquoteScalar(val)
	}
	return out
}

// collectIndentedList gathers consecutive `- item` lines starting at index
// start, returning the item strings (quotes stripped). Stops at the first
// non-list line.
func collectIndentedList(lines []string, start int) []string {
	var items []string
	for j := start; j < len(lines); j++ {
		t := strings.TrimSpace(lines[j])
		if t == "" {
			break
		}
		if !strings.HasPrefix(t, "- ") && t != "-" {
			break
		}
		item := strings.TrimSpace(strings.TrimPrefix(t, "-"))
		if item != "" {
			items = append(items, unquoteScalar(item))
		}
	}
	return items
}

func parseInlineList(val string) []string {
	val = strings.TrimSuffix(strings.TrimPrefix(val, "["), "]")
	parts := strings.Split(val, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = unquoteScalar(strings.TrimSpace(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func unquoteScalar(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// frontmatterString returns a string-valued frontmatter key, trimmed. Returns
// "" when absent or not a scalar string.
func frontmatterString(fm map[string]any, key string) string {
	v, ok := fm[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

// frontmatterList returns a string-list frontmatter value, accepting either a
// parsed list or a comma-separated string, under any of the given key aliases
// (first present wins). Used for allowed-tools / allowed_bash_commands.
func frontmatterList(fm map[string]any, keys ...string) []string {
	for _, key := range keys {
		v, ok := fm[key]
		if !ok || v == nil {
			continue
		}
		switch t := v.(type) {
		case []string:
			return t
		case string:
			parts := strings.Split(t, ",")
			out := make([]string, 0, len(parts))
			for _, p := range parts {
				if p = strings.TrimSpace(p); p != "" {
					out = append(out, p)
				}
			}
			return out
		}
	}
	return nil
}

// frontmatterUserInvocable resolves the `user-invocable` key with the
// source-dependent default: commands default to user-invocable (a user may type
// /name); skills default to model-only (the model invokes via the Skill tool).
func frontmatterUserInvocable(fm map[string]any, source string) bool {
	v, ok := fm["user-invocable"]
	if !ok || v == nil {
		return source != slashSourceSkill
	}
	if s, ok := v.(string); ok {
		return strings.EqualFold(strings.TrimSpace(s), "true")
	}
	return source != slashSourceSkill
}

// frontmatterContext resolves the `context` key: "fork" runs the command as a
// forked sub-agent; anything else (including absent) is inline expansion.
func frontmatterContext(fm map[string]any) string {
	if strings.EqualFold(frontmatterString(fm, "context"), "fork") {
		return "fork"
	}
	return "inline"
}

var (
	argIndexedRE = regexp.MustCompile(`\$ARGUMENTS\[(\d+)\]`)
	argShorthand = regexp.MustCompile(`\$(\d+)`)
)

// substituteArguments expands argument placeholders in a template body with the
// user-supplied args. Supported forms:
//   - $ARGUMENTS      → the full raw argument string
//   - $ARGUMENTS[N]   → the Nth whitespace-split argument (empty if out of range)
//   - $N              → shorthand for $ARGUMENTS[N]
//
// When the body contains NO placeholder and args is non-empty, the args are
// appended as a trailing "ARGUMENTS: {args}" block so a template that does not
// reference $ARGUMENTS still receives the user's input. When args is empty the
// body is returned unchanged (placeholders collapse to empty).
func substituteArguments(body, args string) string {
	original := body
	parsed := strings.Fields(args)

	body = argIndexedRE.ReplaceAllStringFunc(body, func(m string) string {
		sub := argIndexedRE.FindStringSubmatch(m)
		i, _ := strconv.Atoi(sub[1]) //nolint:errcheck // parse failure -> zero value
		if i >= 0 && i < len(parsed) {
			return parsed[i]
		}
		return ""
	})
	body = argShorthand.ReplaceAllStringFunc(body, func(m string) string {
		i, _ := strconv.Atoi(m[1:]) //nolint:errcheck // parse failure -> zero value
		if i >= 0 && i < len(parsed) {
			return parsed[i]
		}
		return ""
	})
	body = strings.ReplaceAll(body, "$ARGUMENTS", args)

	// appendIfNoPlaceholder: nothing was substituted and we have args.
	if body == original && args != "" {
		body = body + "\n\nARGUMENTS: " + args
	}
	return body
}
