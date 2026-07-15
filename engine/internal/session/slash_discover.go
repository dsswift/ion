package session

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// slash_discover.go owns engine-side discovery of the slash commands available
// to a session: the `.md` templates and skills across the conventional roots.
// This is the autocomplete feed consumers use to populate their slash menu — it
// replaces the per-consumer filesystem walk (e.g. the desktop's
// command-discovery.ts) so every consumer gets the same list from one owner.
//
// Extension-registered commands are published separately via the
// engine_command_registry snapshot (command_registry.go); this surface covers
// the filesystem/template side. A consumer unions the two for its menu.

// DiscoverSlashCommands is the exported entry point for the wire
// discover_slash_commands command. It walks the conventional roots for the given
// working directory and returns the user-invocable templates/skills. Stateless:
// no session is required, since discovery is a pure filesystem read.
//
// claudeCompat gates the `.claude` / `~/.claude` roots (commands AND skills),
// mirroring the resolution gate in resolveSlashCommand and the skill-loading
// gate in start_session.go. The consumer hands the engine the flag (via the
// wire command's optional Config); the engine holds no opinion on it.
func (m *Manager) DiscoverSlashCommands(workingDir string, claudeCompat bool) []types.SlashCommandListing {
	return discoverSlashCommands(workingDir, claudeCompat)
}

// discoverSlashCommands walks the conventional command/skill roots for the given
// working directory and returns a de-duplicated, name-sorted listing. Precedence
// matches resolveSlashCommand: a name found in a higher-precedence root shadows
// the same name in a lower one (the first occurrence wins, so we keep the first
// and skip later duplicates). The `.claude` roots are skipped entirely when
// claudeCompat is false.
func discoverSlashCommands(workingDir string, claudeCompat bool) []types.SlashCommandListing {
	home, _ := os.UserHomeDir()

	type root struct {
		dir    string
		source string
	}
	var roots []root
	if workingDir != "" {
		roots = append(roots, root{filepath.Join(workingDir, ".ion", "commands"), slashSourceIon})
	}
	roots = append(roots, root{filepath.Join(home, ".ion", "commands"), slashSourceIon})
	if claudeCompat {
		if workingDir != "" {
			roots = append(roots, root{filepath.Join(workingDir, ".claude", "commands"), slashSourceClaude})
		}
		roots = append(roots, root{filepath.Join(home, ".claude", "commands"), slashSourceClaude})
	}

	seen := map[string]struct{}{}
	var out []types.SlashCommandListing

	for _, r := range roots {
		walkCommandDir(r.dir, r.source, seen, &out)
	}
	// Skills: ~/.claude/skills/<name>/SKILL.md — also gated on claudeCompat.
	if claudeCompat {
		walkSkillsDir(filepath.Join(home, ".claude", "skills"), seen, &out)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	utils.LogWithFields(utils.LevelInfo, "session.slash", "discoverslashcommands found commands ()", map[string]any{"count": len(out), "claude_compat": claudeCompat})
	return out
}

// walkCommandDir adds *.md command templates from a flat commands directory.
// Colon-style nesting (subdirectories) is walked recursively so e2e/setup.md
// surfaces as "e2e:setup".
func walkCommandDir(dir, source string, seen map[string]struct{}, out *[]types.SlashCommandListing) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			// Recurse one level for colon-style names (e2e/setup.md → e2e:setup).
			sub := filepath.Join(dir, e.Name())
			subEntries, subErr := os.ReadDir(sub)
			if subErr != nil {
				continue
			}
			for _, se := range subEntries {
				if se.IsDir() || !strings.HasSuffix(se.Name(), ".md") {
					continue
				}
				name := e.Name() + ":" + strings.TrimSuffix(se.Name(), ".md")
				addListing(filepath.Join(sub, se.Name()), name, source, seen, out)
			}
			continue
		}
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".md")
		addListing(filepath.Join(dir, e.Name()), name, source, seen, out)
	}
}

// walkSkillsDir adds skills from the Claude skills convention (one subdir per
// skill, each with a SKILL.md). The subdirectory name is the command name.
func walkSkillsDir(dir string, seen map[string]struct{}, out *[]types.SlashCommandListing) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		skillFile := filepath.Join(dir, e.Name(), "SKILL.md")
		if _, statErr := os.Stat(skillFile); statErr != nil {
			continue
		}
		addListing(skillFile, e.Name(), slashSourceSkill, seen, out)
	}
}

// addListing reads a template's frontmatter for display metadata and appends a
// listing unless the name was already claimed by a higher-precedence root.
func addListing(path, name, source string, seen map[string]struct{}, out *[]types.SlashCommandListing) {
	if _, dup := seen[name]; dup {
		return
	}
	seen[name] = struct{}{}

	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	fm, _ := parseOpenFrontmatter(string(data))

	// Skills default to model-only; skip those from the user autocomplete feed
	// unless they opt in via user-invocable: true.
	if !frontmatterUserInvocable(fm, source) {
		delete(seen, name) // allow a user-invocable peer in a lower root to win
		return
	}

	*out = append(*out, types.SlashCommandListing{
		Name:         name,
		Description:  frontmatterString(fm, "description"),
		ArgumentHint: frontmatterString(fm, "argument-hint"),
		Source:       source,
	})
}
