package server

import (
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/session"
)

// promptOverridesFromCommand preserves every run option that can affect a
// markdown command when the command wire path resolves it directly. Registered
// extension commands keep the same options until their ctx.sendPrompt call.
func promptOverridesFromCommand(cmd *protocol.ClientCommand) *session.PromptOverrides {
	if cmd == nil {
		return nil
	}
	resolvedExts := cmd.ResolveExtensions()
	return &session.PromptOverrides{
		Model:                               cmd.Model,
		MaxTurns:                            cmd.MaxTurns,
		MaxBudgetUsd:                        cmd.MaxBudgetUsd,
		Extensions:                          resolvedExts,
		NoExtensions:                        cmd.NoExtensions,
		AppendSystemPrompt:                  cmd.AppendSystemPrompt,
		Attachments:                         cmd.Attachments,
		ImplementationPhase:                 cmd.ImplementationPhase,
		ThinkingEffort:                      cmd.ThinkingEffort,
		EnterPlanModeDescription:            cmd.EnterPlanModeDescription,
		PlanModeSparseReminder:              cmd.PlanModeSparseReminder,
		PlanFilePath:                        cmd.PlanFilePath,
		BashAllowlistAdditionsForThisPrompt: cmd.BashAllowlistAdditionsForThisPrompt,
		McpAllowlistAdditionsForThisPrompt:  cmd.McpAllowlistAdditionsForThisPrompt,
		CompactTargetPercent:                cmd.CompactTargetPercent,
		CompactMicroKeepTurns:               cmd.CompactMicroKeepTurns,
		CompactEnabled:                      cmd.CompactEnabled,
		CompactSummaryEnabled:               cmd.CompactSummaryEnabled,
		CompactMemoryEnabled:                cmd.CompactMemoryEnabled,
		ClientWorkspaceContext:              cmd.ClientWorkspaceContext,
		DeliveryId:                          cmd.DeliveryId,
		DisplayText:                         cmd.DisplayText,
		TemporaryAutoFromPlan:               cmd.TemporaryAutoFromPlan,
		InjectionKind:                       resolveClientInjectionKind(cmd.Key, cmd.InjectionKind),
	}
}
