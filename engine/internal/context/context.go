// Package context discovers and processes context files (CLAUDE.md, ION.md, etc.)
// by walking directories upward and inlining referenced includes.
package context

import (
	"os"
	"path/filepath"
	"strings"
)

// WalkerConfig controls how context files are discovered.
type WalkerConfig struct {
	Roots            []string // directories to search (defaults to cwd only)
	FilePatterns     []string // file names to look for (e.g., "CLAUDE.md")
	RecurseParents   bool     // walk upward from cwd toward root
	MaxDepth         int      // max upward levels (0 = unlimited)
	IncludeDirective string   // prefix for inline includes (e.g., "@")
	Deduplication    bool     // skip files already seen by absolute path
}

// DiscoveredContext is a single context file found during walking.
type DiscoveredContext struct {
	Path    string // absolute path to the file
	Content string // file contents (with includes inlined if directive set)
	Source  string // "global", "project", "parent", "include"
	Level   int    // 0 = cwd, 1 = parent, 2 = grandparent, etc.
}

// WalkContextFiles discovers context files starting from cwd. For each root
// directory (or cwd if no roots configured), it searches for files matching
// FilePatterns. If RecurseParents is true, it walks upward from each root.
func WalkContextFiles(cwd string, config WalkerConfig) []DiscoveredContext {
	roots := config.Roots
	if len(roots) == 0 {
		roots = []string{cwd}
	}

	patterns := config.FilePatterns
	if len(patterns) == 0 {
		patterns = []string{"CLAUDE.md", "ION.md"}
	}

	seen := make(map[string]bool)
	var results []DiscoveredContext

	for _, root := range roots {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}

		dir := absRoot
		level := 0

		for {
			if config.MaxDepth > 0 && level > config.MaxDepth {
				break
			}

			for _, pattern := range patterns {
				fp := filepath.Join(dir, pattern)
				if config.Deduplication && seen[fp] {
					continue
				}

				data, err := os.ReadFile(fp)
				if err != nil {
					continue
				}

				seen[fp] = true
				content := string(data)
				if config.IncludeDirective != "" {
					content = ProcessIncludes(content, filepath.Dir(fp), config.IncludeDirective, nil)
				}

				source := classifySource(level)
				results = append(results, DiscoveredContext{
					Path:    fp,
					Content: content,
					Source:  source,
					Level:   level,
				})
			}

			if !config.RecurseParents {
				break
			}

			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
			level++
		}
	}

	return results
}

// ProcessIncludes scans content for lines beginning with the given directive
// prefix followed by a file path. Each referenced file is read and inlined.
// The seen map tracks absolute paths to prevent circular includes.
func ProcessIncludes(content, basePath, directive string, seen map[string]bool) string {
	if directive == "" {
		return content
	}
	if seen == nil {
		seen = make(map[string]bool)
	}

	lines := strings.Split(content, "\n")
	var result []string

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, directive) {
			result = append(result, line)
			continue
		}

		ref := strings.TrimSpace(strings.TrimPrefix(trimmed, directive))
		if ref == "" {
			result = append(result, line)
			continue
		}

		var absRef string
		if filepath.IsAbs(ref) {
			absRef = ref
		} else {
			absRef = filepath.Join(basePath, ref)
		}
		absRef = filepath.Clean(absRef)

		if seen[absRef] {
			result = append(result, "<!-- circular include: "+ref+" -->")
			continue
		}
		seen[absRef] = true

		data, err := os.ReadFile(absRef)
		if err != nil {
			result = append(result, "<!-- include not found: "+ref+" -->")
			continue
		}

		included := ProcessIncludes(string(data), filepath.Dir(absRef), directive, seen)
		result = append(result, included)
	}

	return strings.Join(result, "\n")
}

func classifySource(level int) string {
	switch {
	case level == 0:
		return "project"
	case level > 0:
		return "parent"
	default:
		return "global"
	}
}

// --- Presets ---

// ClaudeCodePreset returns a walker config matching Claude Code conventions.
func ClaudeCodePreset() WalkerConfig {
	return WalkerConfig{
		FilePatterns:     []string{"CLAUDE.md", ".claude/CLAUDE.md"},
		RecurseParents:   true,
		IncludeDirective: "@",
		Deduplication:    true,
	}
}

// PiMonoPreset returns a walker config for Pi monorepo projects.
func PiMonoPreset() WalkerConfig {
	return WalkerConfig{
		FilePatterns:     []string{"CLAUDE.md", ".claude/CLAUDE.md", "PI.md"},
		RecurseParents:   true,
		MaxDepth:         5,
		IncludeDirective: "@",
		Deduplication:    true,
	}
}

// IonPreset returns a walker config for Ion projects.
func IonPreset() WalkerConfig {
	return WalkerConfig{
		FilePatterns:     []string{"CLAUDE.md", "ION.md", ".claude/CLAUDE.md", ".ion/ION.md"},
		RecurseParents:   true,
		IncludeDirective: "@",
		Deduplication:    true,
	}
}

// CreatePreset creates a custom preset with the given overrides merged onto
// sensible defaults.
func CreatePreset(overrides WalkerConfig) WalkerConfig {
	cfg := WalkerConfig{
		FilePatterns:     []string{"CLAUDE.md"},
		RecurseParents:   true,
		IncludeDirective: "@",
		Deduplication:    true,
	}
	if len(overrides.Roots) > 0 {
		cfg.Roots = overrides.Roots
	}
	if len(overrides.FilePatterns) > 0 {
		cfg.FilePatterns = overrides.FilePatterns
	}
	if !overrides.RecurseParents {
		cfg.RecurseParents = overrides.RecurseParents
	}
	if overrides.MaxDepth > 0 {
		cfg.MaxDepth = overrides.MaxDepth
	}
	if overrides.IncludeDirective != "" {
		cfg.IncludeDirective = overrides.IncludeDirective
	}
	return cfg
}
