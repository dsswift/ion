// Package context discovers and processes context files (AGENTS.md, ION.md,
// and—when Claude compatibility is enabled—CLAUDE.md) by walking directories
// upward from the working directory, probing the user's home Ion/Claude roots,
// and inlining referenced includes.
//
// Gating model (mirrors the slash-command / skill subsystem in
// internal/session/slash_resolve.go): Ion-native instruction files
// (AGENTS.md, ION.md, .ion/*) are ALWAYS discovered. Claude-compat files
// (CLAUDE.md, .claude/*) are discovered ONLY when the consumer sets
// ClaudeCompat=true on the walker config. The engine owns no opinion on the
// flag — it honors whatever the consumer (via EngineConfig.ClaudeCompat)
// hands it.
package context

import (
	"os"
	"path/filepath"
	"strings"
)

// WalkerConfig controls how context files are discovered.
type WalkerConfig struct {
	Roots            []string // directories to search (defaults to cwd only)
	FilePatterns     []string // legacy single-tier patterns; when set, used as-is (no gating). Prefer AlwaysPatterns/CompatPatterns.
	AlwaysPatterns   []string // Ion-native file names discovered regardless of ClaudeCompat (e.g., "AGENTS.md", "ION.md")
	CompatPatterns   []string // Claude-compat file names discovered ONLY when ClaudeCompat is true (e.g., "CLAUDE.md")
	ClaudeCompat     bool     // when true, CompatPatterns and the ~/.claude home root are probed
	IncludeHomeRoots bool     // when true, append the user's home Ion root (and ~/.claude when ClaudeCompat) to the walk roots
	RecurseParents   bool     // walk upward from cwd toward root
	MaxDepth         int      // max upward levels (0 = unlimited)
	IncludeDirective string   // prefix for inline includes (e.g., "@")
	Deduplication    bool     // skip files already seen by absolute path
}

// resolvePatterns returns the effective file-name patterns for discovery,
// honoring the ClaudeCompat gate. Logged decision (caller side) records which
// tier was active. When the legacy FilePatterns field is set it wins verbatim
// (back-compat for callers that predate the two-tier split and want exact
// control with no gating).
func (c WalkerConfig) resolvePatterns() []string {
	if len(c.FilePatterns) > 0 {
		return c.FilePatterns
	}
	patterns := append([]string{}, c.AlwaysPatterns...)
	if c.ClaudeCompat {
		patterns = append(patterns, c.CompatPatterns...)
	}
	if len(patterns) == 0 {
		// Bare default: Ion-first. Claude files only when the gate is on.
		patterns = []string{"AGENTS.md", "ION.md"}
		if c.ClaudeCompat {
			patterns = append(patterns, "CLAUDE.md")
		}
	}
	return patterns
}

// homeRoots returns the user's home-directory context roots: the Ion root
// (~/.ion) unconditionally, and the Claude root (~/.claude) only when
// ClaudeCompat is true. Mirrors the home-root probing in slash_resolve.go,
// where ~/.ion/commands is always probed and ~/.claude/commands is gated.
// Returns nil when the home directory cannot be resolved.
func (c WalkerConfig) homeRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	roots := []string{filepath.Join(home, ".ion")}
	if c.ClaudeCompat {
		roots = append(roots, filepath.Join(home, ".claude"))
	}
	return roots
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
// the effective patterns (Ion-native always; Claude-compat only when
// ClaudeCompat is set — see WalkerConfig.resolvePatterns). If RecurseParents
// is true, it walks upward from each root. When IncludeHomeRoots is set, the
// user's home Ion root (and ~/.claude when ClaudeCompat) are appended as
// additional, non-recursive roots so global instruction files are discovered
// the same way ~/.ion/commands and ~/.claude/commands are in slash_resolve.go.
func WalkContextFiles(cwd string, config WalkerConfig) []DiscoveredContext {
	roots := config.Roots
	if len(roots) == 0 {
		roots = []string{cwd}
	}

	patterns := config.resolvePatterns()

	// Home roots are probed non-recursively (we do not ascend above ~/.ion).
	// They are tracked separately so classifySource can mark them "global".
	var homeRoots []string
	if config.IncludeHomeRoots {
		homeRoots = config.homeRoots()
	}
	homeRootSet := make(map[string]bool, len(homeRoots))
	for _, hr := range homeRoots {
		if abs, err := filepath.Abs(hr); err == nil {
			homeRootSet[abs] = true
		}
	}

	seen := make(map[string]bool)
	var results []DiscoveredContext

	// Walk the recursive (cwd-derived) roots first, then the non-recursive
	// home roots. Dedup via the shared seen map means a file reachable from
	// both (e.g. cwd is itself under ~/.ion) is loaded exactly once.
	for _, root := range roots {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}

		dir := absRoot
		level := 0

		// Stop walking either when we hit MaxDepth (if configured) or
		// when filesystem traversal exits via the inner `break`/`continue`
		// logic. MaxDepth==0 means "unlimited" — common for repo-wide
		// scans — so we keep the unconditional `for` shape behind a
		// helper expression rather than restructuring the loop.
		for config.MaxDepth == 0 || level <= config.MaxDepth {

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

				source := classifySource(level, homeRootSet[dir])
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

	// Home roots: probed non-recursively (single directory each), classified
	// as "global". Deduped against everything already found above.
	for _, hr := range homeRoots {
		absHome, err := filepath.Abs(hr)
		if err != nil {
			continue
		}
		for _, pattern := range patterns {
			fp := filepath.Join(absHome, pattern)
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
			results = append(results, DiscoveredContext{
				Path:    fp,
				Content: content,
				Source:  "global",
				Level:   0,
			})
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

// classifySource labels a discovered file by where it was found. A file under
// a home root (~/.ion, ~/.claude) is "global". Otherwise level 0 (the working
// directory) is "project" and any ancestor is "parent".
func classifySource(level int, isHome bool) string {
	switch {
	case isHome:
		return "global"
	case level == 0:
		return "project"
	default:
		return "parent"
	}
}

// --- Presets ---

// IonPreset returns a walker config for Ion projects. Ion-native instruction
// files (AGENTS.md, ION.md, and their .ion/ variants) are always discovered;
// Claude-compat files (CLAUDE.md, .claude/CLAUDE.md) are discovered only when
// the caller sets ClaudeCompat on the returned config. The user's home Ion
// root (~/.ion) is always probed; ~/.claude is probed only when ClaudeCompat.
//
// The returned config has ClaudeCompat=false. Callers that honor the
// consumer's Claude-compatibility setting set it explicitly:
//
//	cfg := IonPreset()
//	cfg.ClaudeCompat = s.config.ClaudeCompat
func IonPreset() WalkerConfig {
	return WalkerConfig{
		AlwaysPatterns:   []string{"AGENTS.md", "ION.md", ".ion/ION.md", ".ion/AGENTS.md"},
		CompatPatterns:   []string{"CLAUDE.md", ".claude/CLAUDE.md"},
		IncludeHomeRoots: true,
		RecurseParents:   true,
		IncludeDirective: "@",
		Deduplication:    true,
	}
}

// CreatePreset creates a custom preset with the given overrides merged onto
// sensible Ion-first defaults. The default always-tier is the Ion-native
// instruction files; Claude-compat patterns and home roots are opt-in via the
// overrides (ClaudeCompat, CompatPatterns, IncludeHomeRoots).
func CreatePreset(overrides WalkerConfig) WalkerConfig {
	cfg := WalkerConfig{
		AlwaysPatterns:   []string{"AGENTS.md", "ION.md"},
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
	if len(overrides.AlwaysPatterns) > 0 {
		cfg.AlwaysPatterns = overrides.AlwaysPatterns
	}
	if len(overrides.CompatPatterns) > 0 {
		cfg.CompatPatterns = overrides.CompatPatterns
	}
	cfg.ClaudeCompat = overrides.ClaudeCompat
	cfg.IncludeHomeRoots = overrides.IncludeHomeRoots
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
