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

	var sb strings.Builder
	sb.WriteString("\n\nAvailable skills:\n")
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
			fmt.Fprintf(&sb, "… and %d more skill(s) not shown (budget limit).\n", remaining)
			break
		}

		sb.WriteString(line)
		sb.WriteString("\n")
		totalChars += len(line) + 1
		listed++
	}
	return sb.String()
}

// buildSkillToolDescription constructs the full Skill tool description string,
// embedding a budgeted manifest of currently-registered model-invocable skills.
// It is called at session start after skill loading completes so the description
// reflects the actual loaded registry.
func buildSkillToolDescription() string {
	base := "Execute a skill by name. Returns the skill content for execution."
	manifest := buildSkillManifest()
	if manifest == "" {
		return base
	}
	return base + manifest
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
	// model. The user can still type /skill-name to inline the content via
	// the desktop's CLI-compat expansion path.
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
