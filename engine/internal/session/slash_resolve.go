package session

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// slash_resolve.go owns the engine-side resolution and expansion of a
// slash-command invocation (`/name args`) into the prompt the model sees.
//
// This is the load-bearing "executing commands and skills" mechanic that every
// consumer would otherwise have to reimplement (path probing across the
// conventional roots, frontmatter parsing, $ARGUMENTS substitution). Per the
// engine-design principle (AGENTS.md § "Opinionless mechanics, extensible
// opinions"), the engine owns the mechanism and ships the generic standard;
// consumers send the raw `/name args` and render the raw invocation.
//
// The companion split lives in conversation.AddUserMessageWithInvocation: the
// EXPANDED body goes to the LLM (conv.Messages); the RAW invocation is persisted
// as the displayed user turn (conv.Entries). This file only resolves + expands;
// it does not touch the conversation.

// SlashSource labels where a command template resolved from. These are the
// stable string values carried on the persisted entry (MessageData.SlashSource)
// and the wire (SessionMessage.SlashSource) so a consumer can label the pill by
// origin.
const (
	slashSourceExtension = "extension"
	slashSourceIon       = "ion"
	slashSourceClaude    = "claude"
	slashSourceSkill     = "skill"
	slashSourceProject   = "project"
)

// ResolvedSlash is the outcome of resolving a slash invocation.
type ResolvedSlash struct {
	// Command is the raw command name including the leading slash ("/diagram").
	Command string
	// Args is the raw argument string the user typed after the command name.
	Args string
	// Source is one of the slashSource* constants.
	Source string
	// ExpandedBody is the template body with $ARGUMENTS substituted (or the
	// trailing ARGUMENTS block appended). This is what the model consumes.
	ExpandedBody string
	// Frontmatter is the full parsed frontmatter map — known keys AND any
	// unknown keys, preserved verbatim. Extensions read this (via the
	// resolution hook) to branch on keys the engine ignores.
	Frontmatter map[string]any
	// Known typed fields lifted out of Frontmatter for engine use. Empty when
	// the template declares no such key.
	Model               string   // frontmatter `model`
	AllowedBashCommands []string // frontmatter `allowed-tools` / `allowed_bash_commands`
	UserInvocable       bool     // frontmatter `user-invocable` (resolved with source default)
	Context             string   // frontmatter `context`: "inline" (default) | "fork"
}

// slashRE parses a leading slash invocation. The command name must start with a
// letter so filesystem-style paths ("/usr/bin/foo") and regexes ("/^x/") do not
// match a bare leading slash. Colon-delimited names (e2e:setup) are allowed and
// map to subdirectory paths during resolution.
var slashRE = regexp.MustCompile(`^/([a-zA-Z][a-zA-Z0-9_:-]*)\s*([\s\S]*)$`)

// parseSlashInvocation splits "/name args" into (name without slash, args). The
// engine never runs this on its own initiative — the consumer sets
// RunOptions.ResolveSlash to opt a prompt into resolution (see the field
// comment on types.RunOptions). Returns ok=false when text is not a
// letter-led slash invocation.
func parseSlashInvocation(text string) (name, args string, ok bool) {
	m := slashRE.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return "", "", false
	}
	return m[1], strings.TrimSpace(m[2]), true
}

// resolveSlashCommand resolves a slash invocation against the conventional
// template roots and expands it. workingDir is the session's project directory
// (used for project-scoped roots). extNames is the set of extension-registered
// command names (those take precedence and are NOT resolved here — the caller
// dispatches them through the extension command path instead; this function
// returns ok=false with source=extension so the caller can route).
//
// Precedence (first match wins):
//  1. {workingDir}/.ion/commands/{name}.md      → ion
//  2. ~/.ion/commands/{name}.md                 → ion
//  3. {workingDir}/.claude/commands/{name}.md   → claude
//  4. ~/.claude/commands/{name}.md              → claude
//  5. ~/.claude/skills/{name}/SKILL.md          → skill
//
// Colon-delimited names map to subdirectory paths (e2e:setup → e2e/setup.md).
// Returns ok=false when no template is found on disk (caller surfaces
// unknown_command).
//
// claudeCompat gates ALL `.claude` / `~/.claude` roots (commands AND skills):
// when false, only the `.ion` roots are probed, mirroring the skill-loading
// gate in start_session.go. The engine owns no opinion on the flag — it honors
// whatever the consumer hands it (here, via the session's EngineConfig).
func resolveSlashCommand(name, args, workingDir string, claudeCompat bool) (*ResolvedSlash, bool) {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	filePath := strings.ReplaceAll(name, ":", string(filepath.Separator)) + ".md"

	type candidate struct {
		path   string
		source string
	}
	var candidates []candidate
	if workingDir != "" {
		candidates = append(candidates, candidate{filepath.Join(workingDir, ".ion", "commands", filePath), slashSourceIon})
	}
	candidates = append(candidates, candidate{filepath.Join(home, ".ion", "commands", filePath), slashSourceIon})
	// .claude command + skill roots are gated on claudeCompat. When the
	// consumer has Claude compatibility disabled, these are never probed.
	if claudeCompat {
		if workingDir != "" {
			candidates = append(candidates, candidate{filepath.Join(workingDir, ".claude", "commands", filePath), slashSourceClaude})
		}
		candidates = append(candidates, candidate{filepath.Join(home, ".claude", "commands", filePath), slashSourceClaude})
		if !strings.Contains(name, ":") {
			candidates = append(candidates, candidate{filepath.Join(home, ".claude", "skills", name, "SKILL.md"), slashSourceSkill})
		}
	}

	for _, c := range candidates {
		data, err := os.ReadFile(c.path)
		if err != nil {
			continue
		}
		fm, body := parseOpenFrontmatter(string(data))
		expanded := substituteArguments(body, args)

		utils.LogWithFields(utils.LevelInfo, "session.slash", "resolved", map[string]any{"model": name, "reason": c.source, "path": c.path, "count": len(args), "max": len(body)})

		return &ResolvedSlash{
			Command:             "/" + name,
			Args:                args,
			Source:              c.source,
			ExpandedBody:        expanded,
			Frontmatter:         fm,
			Model:               frontmatterString(fm, "model"),
			AllowedBashCommands: frontmatterList(fm, "allowed-tools", "allowed_bash_commands"),
			UserInvocable:       frontmatterUserInvocable(fm, c.source),
			Context:             frontmatterContext(fm),
		}, true
	}

	utils.LogWithFields(utils.LevelInfo, "session.slash", "no template found name=/", map[string]any{"model": name, "working_dir": workingDir})
	return nil, false
}

// resolveSlashIntoOpts resolves the slash invocation carried in opts.Prompt and,
// on success, rewrites opts.Prompt to the EXPANDED body and records the raw
// invocation on opts (ResolvedSlash* fields) so the runloop persists the
// invocation as the display turn. Frontmatter model / allowed-bash hints are
// applied with a no-stomp policy (an explicit per-prompt override wins). On
// failure (not a parseable invocation, or no template found) it emits an
// unknown_command result and returns false so SendPrompt aborts the prompt
// without starting a run.
//
// Called with m.mu held (SendPrompt holds the lock across buildRunOptions).
// resolveSlashCommand only touches the filesystem and is safe under the lock.
// resolveSlashIntoOpts resolves a slash invocation and rewrites opts in place.
// Returns (true, "") on success. On failure returns (false, failedCommand) where
// failedCommand is the string to pass to emitUnknownCommand. The caller is
// responsible for emitting the unknown-command event AFTER releasing m.mu,
// because emit acquires m.mu.RLock which deadlocks under a held write lock.
func (m *Manager) resolveSlashIntoOpts(s *engineSession, key string, opts *types.RunOptions) (bool, string) {
	name, args, ok := parseSlashInvocation(opts.Prompt)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session.slash", "resolveslash set but prompt is not a slash invocation", map[string]any{"key": key})
		return false, opts.Prompt
	}

	res, found := resolveSlashCommand(name, args, s.config.WorkingDirectory, s.config.ClaudeCompat)
	if !found {
		utils.LogWithFields(utils.LevelInfo, "session.slash", "unknown command name=/", map[string]any{"key": key, "model": name})
		return false, "/" + name
	}

	// Fire the resolution hook so an extension can observe/override before the
	// expanded body is committed. The hook sees the full frontmatter map and
	// the invocation metadata; a returned override replaces the expanded body.
	if override, ok := m.fireSlashResolved(s, key, res); ok {
		res.ExpandedBody = override
	}

	// Rewrite the LLM-visible prompt to the expanded body; stash the raw
	// invocation for the runloop's display-turn persistence.
	opts.Prompt = res.ExpandedBody
	opts.ResolvedSlashCommand = res.Command
	opts.ResolvedSlashArgs = res.Args
	opts.ResolvedSlashSource = res.Source
	opts.ResolvedSlashContext = res.Context

	// Apply frontmatter model hint (no-stomp: explicit per-prompt override wins).
	if res.Model != "" && opts.Model == "" {
		opts.Model = res.Model
		utils.LogWithFields(utils.LevelInfo, "session.slash", "applied frontmatter", map[string]any{"model": res.Model, "key": key})
	}
	// Apply frontmatter allowed-bash additions for this run (union, transient).
	if len(res.AllowedBashCommands) > 0 {
		opts.BashAllowlistAdditionsForThisPrompt = unionStrings(
			opts.BashAllowlistAdditionsForThisPrompt, res.AllowedBashCommands)
		utils.LogWithFields(utils.LevelInfo, "session.slash", "applied frontmatter bash additions", map[string]any{"count": len(res.AllowedBashCommands), "key": key})
	}

	utils.LogWithFields(utils.LevelInfo, "session.slash", "resolved into opts", map[string]any{"session_id": key, "reason": res.Command, "status": res.Source, "count": len(res.ExpandedBody)})
	return true, ""
}

// fireSlashResolved fires the slash_command_resolved hook so an extension can
// observe the resolved invocation (full frontmatter + metadata) and optionally
// override the expanded body. Returns (override, true) when a handler overrode.
// No-op (returns "", false) when the session has no extensions — a plain
// conversation resolves slash commands with the engine's generic behavior.
//
// Called with m.mu held (from resolveSlashIntoOpts → SendPrompt).
func (m *Manager) fireSlashResolved(s *engineSession, key string, res *ResolvedSlash) (string, bool) {
	if s.extGroup == nil || s.extGroup.IsEmpty() {
		return "", false
	}
	ctx := m.newExtContext(s, key)
	override, ok := s.extGroup.FireSlashCommandResolved(ctx, extension.SlashResolvedInfo{
		Command:      res.Command,
		Args:         res.Args,
		Source:       res.Source,
		Frontmatter:  res.Frontmatter,
		ExpandedBody: res.ExpandedBody,
	})
	if ok {
		utils.LogWithFields(utils.LevelInfo, "session.slash", "slash_command_resolved hook overrode body", map[string]any{"key": key, "command": res.Command, "count": len(override)})
	}
	return override, ok
}

// emitUnknownCommand emits the canonical engine_command_result for an
// unresolved slash invocation, matching the shape command_dispatch.go uses so
// consumers route both paths identically.
func (m *Manager) emitUnknownCommand(key, command string) {
	m.emit(key, types.EngineEvent{
		Type:         "engine_command_result",
		EventMessage: "unknown command: " + command,
		Command:      command,
		CommandError: "unknown_command",
	})
}

// unionStrings appends src entries not already present in dst (de-duplicated,
// order-preserving — dst entries keep their position).
func unionStrings(dst, src []string) []string {
	seen := make(map[string]struct{}, len(dst))
	for _, d := range dst {
		seen[d] = struct{}{}
	}
	for _, s := range src {
		if _, ok := seen[s]; !ok {
			dst = append(dst, s)
			seen[s] = struct{}{}
		}
	}
	return dst
}
