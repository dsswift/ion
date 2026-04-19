// Package skills loads skill definitions from markdown files with YAML-ish
// frontmatter (key: value lines between --- markers).
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
}

// SkillPaths holds conventional skill directory paths.
type SkillPaths struct {
	User    string // per-user skills directory
	Project string // project-local skills directory
}

// LoadSkill reads a markdown file and parses it into a Skill. Frontmatter is
// delimited by --- lines and contains key: value pairs. The name and description
// fields are extracted from frontmatter; the rest of the file is content.
func LoadSkill(path string) (*Skill, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	text := string(data)
	metadata := make(map[string]string)
	var content string

	if strings.HasPrefix(strings.TrimSpace(text), "---") {
		lines := strings.SplitN(text, "\n", -1)
		inFrontmatter := false
		fmEnd := 0

		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "---" {
				if !inFrontmatter {
					inFrontmatter = true
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
					metadata[key] = val
				}
			}
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

	return &Skill{
		Name:        name,
		Description: metadata["description"],
		Content:     content,
		Source:      path,
		Metadata:    metadata,
	}, nil
}

// LoadSkillDirectory loads all skills from a directory. If filter is non-nil,
// only files for which filter(path) returns true are loaded.
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

// ClaudeCodeSkillPaths returns the conventional skill paths for Claude Code.
func ClaudeCodeSkillPaths() SkillPaths {
	home, _ := os.UserHomeDir()
	return SkillPaths{
		User:    filepath.Join(home, ".claude", "skills"),
		Project: filepath.Join(".", ".claude", "skills"),
	}
}

// PiSkillPaths returns the conventional skill paths for Pi.
func PiSkillPaths() SkillPaths {
	home, _ := os.UserHomeDir()
	return SkillPaths{
		User:    filepath.Join(home, ".pi", "skills"),
		Project: filepath.Join(".", ".pi", "skills"),
	}
}

// IonSkillPaths returns the conventional skill paths for Ion.
func IonSkillPaths() SkillPaths {
	home, _ := os.UserHomeDir()
	return SkillPaths{
		User:    filepath.Join(home, ".ion", "skills"),
		Project: filepath.Join(".", ".ion", "skills"),
	}
}
