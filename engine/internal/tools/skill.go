package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

// SkillTool returns a ToolDef that invokes a loaded skill by name.
func SkillTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Skill",
		Description: "Invoke a loaded skill by name. Returns the skill content for execution.",
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
