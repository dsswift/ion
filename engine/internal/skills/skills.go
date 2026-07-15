// Package skills loads skill definitions from markdown files with YAML-ish
// frontmatter (key: value lines between --- markers). Single-line values and
// YAML block scalars (> for folded, | for literal) are both supported.
package skills

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

var (
	registryMu sync.RWMutex
	registry   = make(map[string]*Skill)
)

// RegisterSkill adds or replaces a skill in the registry.
func RegisterSkill(s *Skill) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[s.Name] = s
}

// GetSkill returns a skill by name, or nil if not found.
func GetSkill(name string) *Skill {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return registry[name]
}

// GetAllSkills returns all registered skills.
func GetAllSkills() []*Skill {
	registryMu.RLock()
	defer registryMu.RUnlock()
	result := make([]*Skill, 0, len(registry))
	for _, s := range registry {
		result = append(result, s)
	}
	return result
}

// ListSkillNames returns sorted names of all registered skills.
func ListSkillNames() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ClearSkillRegistry removes all skills from the registry.
func ClearSkillRegistry() {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry = make(map[string]*Skill)
}

// Skill is a loaded skill definition.
type Skill struct {
	Name        string
	Description string
	Content     string
	Source      string
	Metadata    map[string]string

	// WhenToUse is a brief prose hint for the model describing when to invoke
	// this skill. Populated from the `when_to_use` frontmatter key, matching
	// Claude Code's skill format. Empty means no hint is shown.
	WhenToUse string

	// DisableModelInvocation, when true, prevents the Skill tool from listing
	// or executing this skill. Consumers may still invoke the skill out-of-band
	// (e.g. a user-typed slash command that inlines the skill content) — that
	// path is a harness concern and is not gated by this flag. Populated from
	// the `disable-model-invocation` frontmatter key; treat "true" (case-
	// insensitive) as true, anything else as false.
	DisableModelInvocation bool
}

// SkillPaths holds conventional skill directory paths.
type SkillPaths struct {
	User       string // per-user Ion skills directory (~/.ion/skills)
	Project    string // project-local Ion skills directory (./.ion/skills)
	ClaudeUser string // per-user Claude Code skills directory (~/.claude/skills)
}

// LoadSkill reads a markdown file and parses it into a Skill. Frontmatter is
// delimited by --- lines. Key-value pairs use either the simple `key: value`
// form or YAML block scalar form (`key: >` or `key: |` followed by indented
// continuation lines). The name and description fields are extracted from
// frontmatter; the rest of the file is content.
func LoadSkill(path string) (*Skill, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	text := string(data)
	metadata := make(map[string]string)
	var content string

	if strings.HasPrefix(strings.TrimSpace(text), "---") {
		lines := strings.Split(text, "\n")
		inFrontmatter := false
		fmEnd := 0

		i := 0
		for i < len(lines) {
			line := lines[i]
			trimmed := strings.TrimSpace(line)

			if trimmed == "---" {
				if !inFrontmatter {
					inFrontmatter = true
					i++
					continue
				}
				// Closing delimiter.
				fmEnd = i + 1
				break
			}

			if inFrontmatter {
				if idx := strings.Index(trimmed, ":"); idx > 0 {
					key := strings.TrimSpace(trimmed[:idx])
					val := strings.TrimSpace(trimmed[idx+1:])

					// Detect YAML block scalar indicators: > (folded) or | (literal).
					// Trailing spaces on the indicator line are normalised away.
					indicator := strings.TrimRight(val, " \t")
					if indicator == ">" || indicator == "|" {
						i++ // advance past the indicator line
						val = collectBlockScalar(lines, &i, indicator == ">")
						// i now points to the first non-continuation line; do not
						// advance again — continue restarts the loop without i++.
						metadata[key] = val
						continue
					}

					metadata[key] = val
				}
			}
			i++
		}

		if fmEnd > 0 && fmEnd < len(lines) {
			content = strings.Join(lines[fmEnd:], "\n")
		} else if fmEnd == 0 {
			// No closing ---; treat entire file as content.
			content = text
		}
	} else {
		content = text
	}

	content = strings.TrimSpace(content)

	name := metadata["name"]
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}

	disableModelInvocation := strings.EqualFold(metadata["disable-model-invocation"], "true")

	return &Skill{
		Name:                   name,
		Description:            metadata["description"],
		Content:                content,
		Source:                 path,
		Metadata:               metadata,
		WhenToUse:              metadata["when_to_use"],
		DisableModelInvocation: disableModelInvocation,
	}, nil
}

// collectBlockScalar gathers indented continuation lines starting at lines[*i].
// On return, *i points to the first non-continuation line (next key or ---).
// A continuation line is any line that begins with a space or tab character.
// If folded is true, non-empty trimmed lines are joined with a single space
// (YAML > style); otherwise they are joined with newlines (YAML | style).
func collectBlockScalar(lines []string, i *int, folded bool) string {
	var parts []string
	for *i < len(lines) {
		line := lines[*i]
		// A continuation line must start with whitespace.
		if len(line) == 0 || (line[0] != ' ' && line[0] != '\t') {
			break
		}
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			parts = append(parts, trimmed)
		}
		*i++
	}
	if folded {
		return strings.Join(parts, " ")
	}
	return strings.Join(parts, "\n")
}

// LoadSkillDirectory loads all skills from a directory. Two formats are
// supported and may coexist in the same directory:
//
//   - Flat markdown file: <name>.md or <name>.markdown. The skill name comes
//     from the `name` frontmatter key, falling back to the filename stem.
//
//   - Subdirectory layout: <name>/SKILL.md. The skill name is always the
//     directory name, overriding any `name` key in the frontmatter. This is
//     the industry-standard layout used by Claude Code, caveman, and most
//     third-party skill repositories.
//
// If filter is non-nil, only paths for which filter(path) returns true are
// loaded. For subdirectory skills the path passed to filter is the full path
// of the SKILL.md file (e.g. /home/user/.ion/skills/caveman/SKILL.md).
//
// Missing or empty directories return nil, nil. Real I/O errors on the root
// ReadDir call are returned; per-file and per-subdirectory errors are silently
// skipped.
func LoadSkillDirectory(dir string, filter func(string) bool) ([]*Skill, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var skills []*Skill
	for _, entry := range entries {
		if entry.IsDir() {
			// Subdirectory layout: check for SKILL.md inside.
			skillFile := filepath.Join(dir, entry.Name(), "SKILL.md")
			if _, statErr := os.Stat(skillFile); os.IsNotExist(statErr) {
				// No SKILL.md — skip silently.
				continue
			}
			if filter != nil && !filter(skillFile) {
				continue
			}
			skill, err := LoadSkill(skillFile)
			if err != nil {
				// Unreadable or malformed SKILL.md — skip silently, consistent
				// with the per-file skip-on-error behaviour for flat files.
				continue
			}
			// Override the name with the directory name, matching Claude Code semantics.
			skill.Name = entry.Name()
			skills = append(skills, skill)
			continue
		}

		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".md" && ext != ".markdown" {
			continue
		}

		fp := filepath.Join(dir, entry.Name())
		if filter != nil && !filter(fp) {
			continue
		}

		skill, err := LoadSkill(fp)
		if err != nil {
			continue
		}
		skills = append(skills, skill)
	}
	return skills, nil
}

// LoadClaudeSkillsDirectory loads skills from a Claude Code–style skills
// directory. Claude Code's convention is one subdirectory per skill, each
// containing a SKILL.md file (e.g. ~/.claude/skills/ilograph/SKILL.md). The
// subdirectory name is used as the skill name, overriding any `name` key in
// the frontmatter — this matches Claude Code's loadSkillsFromSkillsDir which
// also derives the skill name from the directory name.
//
// Subdirectories without a SKILL.md are silently skipped. An error is returned
// only for real I/O failures; a missing or empty root directory returns nil,
// nil (same convention as LoadSkillDirectory).
func LoadClaudeSkillsDirectory(dir string) ([]*Skill, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var skills []*Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		skillFile := filepath.Join(dir, entry.Name(), "SKILL.md")
		if _, statErr := os.Stat(skillFile); os.IsNotExist(statErr) {
			// No SKILL.md in this subdirectory — skip silently.
			continue
		}

		skill, err := LoadSkill(skillFile)
		if err != nil {
			// Unreadable or malformed SKILL.md — skip silently (consistent
			// with LoadSkillDirectory's per-file skip-on-error behaviour).
			continue
		}
		// Override the name with the directory name, matching Claude Code.
		skill.Name = entry.Name()
		skills = append(skills, skill)
	}
	return skills, nil
}

// IonSkillPaths returns the conventional skill paths for Ion.
func IonSkillPaths() SkillPaths {
	home, _ := os.UserHomeDir()
	return SkillPaths{
		User:       filepath.Join(home, ".ion", "skills"),
		Project:    filepath.Join(".", ".ion", "skills"),
		ClaudeUser: filepath.Join(home, ".claude", "skills"),
	}
}
