package agentdiscovery

import (
	"fmt"
	"path/filepath"
	"strings"
)

// parseFrontmatter splits a markdown file into YAML frontmatter fields and body.
// Expects --- fences. Returns parsed AgentDef with SystemPrompt set to the body.
func parseFrontmatter(path, content string) (*AgentDef, error) {
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "---") {
		return nil, fmt.Errorf("no frontmatter fence in %s", path)
	}

	// Find second fence
	rest := trimmed[3:]
	rest = strings.TrimLeft(rest, "\r\n")
	idx := strings.Index(rest, "\n---")
	if idx < 0 {
		return nil, fmt.Errorf("unclosed frontmatter fence in %s", path)
	}

	fmBlock := rest[:idx]
	body := strings.TrimSpace(rest[idx+4:]) // skip \n---

	def := &AgentDef{
		Name: stemFromPath(path),
		Path: path,
		Meta: make(map[string]string),
	}
	def.SystemPrompt = body

	// Parse key: value lines from frontmatter
	for _, line := range strings.Split(fmBlock, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colonIdx])
		val := strings.TrimSpace(line[colonIdx+1:])

		switch key {
		case "name":
			def.Name = val
		case "parent":
			def.Parent = val
		case "description":
			def.Description = val
		case "model":
			def.Model = val
		case "tools":
			def.Tools = parseList(val)
		default:
			def.Meta[key] = val
		}
	}

	return def, nil
}

// parseList handles both inline [a, b, c] and bare comma-separated values.
func parseList(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// stemFromPath returns the filename without extension.
func stemFromPath(path string) string {
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	return strings.TrimSuffix(base, ext)
}
