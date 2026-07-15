package tools

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

// SkillManifestPerEntryMaxChars is the maximum number of characters rendered
// for each skill entry in the Skill tool description manifest. Matches Claude
// Code's MAX_LISTING_DESC_CHARS constant.
const SkillManifestPerEntryMaxChars = 250

// SkillManifestDefaultBudget is the approximate character budget for the full
// skill manifest block in the tool description. ~1% of 200k tokens × 4
// chars/token (Claude Code's SKILL_BUDGET_CONTEXT_PERCENT = 0.01). Skills are
// listed until this budget is exhausted, then a truncation note is appended.
const SkillManifestDefaultBudget = 8000

// buildSkillManifest returns the "Available skills:" block to embed in the
// Skill tool description. Skills with DisableModelInvocation=true are omitted.
// Entries are sorted alphabetically and capped at SkillManifestPerEntryMaxChars
// each; the total manifest is capped at SkillManifestDefaultBudget characters.
//
// Format (matches Claude Code's formatCommandsWithinBudget):
//
//	- <name>: <description> - <whenToUse>    (when WhenToUse is set)
//	- <name>: <description>                  (when WhenToUse is empty)
func buildSkillManifest() string {
	all := skills.GetAllSkills()
	if len(all) == 0 {
		return ""
	}

	// Sort for deterministic output.
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })

	// Build entries first so we can return "" when every skill is disabled.
	// Writing the header before iterating would produce a non-empty string
	// even when all entries are filtered out by DisableModelInvocation.
	var entries strings.Builder
	totalChars := 0
	listed := 0

	for _, sk := range all {
		if sk.DisableModelInvocation {
			continue
		}
		// Build the entry line.
		var entry strings.Builder
		entry.WriteString("- ")
		entry.WriteString(sk.Name)
		if sk.Description != "" {
			entry.WriteString(": ")
			entry.WriteString(sk.Description)
		}
		if sk.WhenToUse != "" {
			entry.WriteString(" - ")
			entry.WriteString(sk.WhenToUse)
		}
		line := entry.String()

		// Truncate to per-entry cap. "…" is 3 bytes (UTF-8 ellipsis), so
		// truncate to cap-3 bytes so the final line is exactly cap bytes long.
		if len(line) > SkillManifestPerEntryMaxChars {
			line = line[:SkillManifestPerEntryMaxChars-3] + "…"
		}

		// Check total budget.
		if totalChars+len(line)+1 > SkillManifestDefaultBudget {
			// Budget exhausted — note that some skills were omitted.
			remaining := len(all) - listed
			fmt.Fprintf(&entries, "… and %d more skill(s) not shown (budget limit).\n", remaining)
			break
		}

		entries.WriteString(line)
		entries.WriteString("\n")
		totalChars += len(line) + 1
		listed++
	}

	if listed == 0 && entries.Len() == 0 {
		// Every skill was filtered out by DisableModelInvocation.
		return ""
	}

	return "\n\nAvailable skills:\n" + entries.String()
}

// skillProactiveInstruction is the behavioral instruction appended to the Skill
// tool description and injected into the system prompt when skills are loaded.
// Mirrors Claude Code's "BLOCKING REQUIREMENT" language from SkillTool/prompt.ts
// so third-party skills authored for Claude Code behave identically on Ion.
const skillProactiveInstruction = "When a user's request matches an available skill, " +
	"you MUST invoke this tool for that skill BEFORE generating any other response. " +
	"This is a blocking requirement — never mention a skill without calling this tool."

// buildSkillToolDescription constructs the full Skill tool description string,
// embedding a budgeted manifest of currently-registered model-invocable skills
// and the proactive-invocation instruction. It is called at session start after
// skill loading completes so the description reflects the actual loaded registry.
func buildSkillToolDescription() string {
	manifest := buildSkillManifest()
	if manifest == "" {
		return "Execute a skill by name. Returns the skill content for execution."
	}
	return "Execute a skill by name. Returns the skill content for execution. " +
		skillProactiveInstruction + manifest
}

// BuildSkillSystemPromptSection returns a system prompt section that lists all
// model-invocable skills and instructs the model to invoke them proactively.
// Returns empty string when no skills are registered so callers can skip the
// append without injecting blank content. Mirrors Claude Code's skill_listing
// attachment (attachments.ts → messages.ts skill_listing case) which wraps the
// skill list in a <system-reminder> user message on every turn — Ion delivers
// the same information more cleanly via the system prompt assembled per run in
// buildSystemPrompt.
func BuildSkillSystemPromptSection() string {
	manifest := buildSkillManifest()
	if manifest == "" {
		return ""
	}
	return "# Available Skills\n\n" +
		"The following skills are available via the Skill tool. " +
		"When a user's request matches a skill, you MUST invoke the Skill tool for that skill " +
		"BEFORE generating any other response. " +
		"This is a blocking requirement — never mention a skill without calling the Skill tool." +
		manifest
}

// SkillTool returns a ToolDef that invokes a loaded skill by name. The tool
// description is computed at call time so it reflects the skills currently in
// the registry; call RefreshSkillToolDescription() after loading skills to
// update the registered tool's description.
func SkillTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Skill",
		Description: buildSkillToolDescription(),
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"skill": map[string]any{
					"type":        "string",
					"description": "The name of the skill to invoke.",
				},
				"args": map[string]any{
					"type":        "string",
					"description": "Optional arguments to pass to the skill.",
				},
			},
			"required": []string{"skill"},
		},
		Execute: executeSkill,
	}
}

// RefreshSkillToolDescription re-registers the Skill tool with a freshly-built
// description that reflects the current skill registry. Called from
// start_session.go after skill loading completes so the model's tool manifest
// lists the available skills.
func RefreshSkillToolDescription() {
	RegisterTool(SkillTool())
}

func executeSkill(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: Skill cancelled.", IsError: true}, nil
	}
	name, _ := input["skill"].(string)
	if name == "" {
		return &types.ToolResult{Content: "Missing required parameter: skill", IsError: true}, nil
	}

	args, _ := input["args"].(string)

	available := skills.ListSkillNames()
	if len(available) == 0 {
		return &types.ToolResult{Content: "No skills registered", IsError: true}, nil
	}

	skill := skills.GetSkill(name)
	if skill == nil {
		return &types.ToolResult{
			Content: fmt.Sprintf("Unknown skill: %s\nAvailable skills: %s", name, strings.Join(available, ", ")),
			IsError: true,
		}, nil
	}

	// Skills with disable-model-invocation: true cannot be invoked by the
	// model. Consumers may still inline the skill content through their own
	// slash-command / template-expansion paths; that path is a harness concern
	// and runs outside this tool.
	if skill.DisableModelInvocation {
		return &types.ToolResult{
			Content: fmt.Sprintf(
				"Skill %q cannot be invoked by the model (disable-model-invocation is set). "+
					"Use the user-typed slash form instead: /%s",
				name, name,
			),
			IsError: true,
		}, nil
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "# Skill: %s\n", skill.Name)
	if skill.Description != "" {
		fmt.Fprintf(&sb, "> %s\n", skill.Description)
	}
	if args != "" {
		fmt.Fprintf(&sb, "Arguments: %s\n", args)
	}
	sb.WriteString(skill.Content)

	return &types.ToolResult{Content: sb.String()}, nil
}
