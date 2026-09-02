package session

// mergeCommandPromptOverrides preserves the client-authored command request and
// lets the registered extension command override only values it supplied when
// it calls ctx.sendPrompt.
func mergeCommandPromptOverrides(command, extension *PromptOverrides) *PromptOverrides {
	if command == nil {
		return clonePromptOverrides(extension)
	}
	merged := clonePromptOverrides(command)
	if extension == nil {
		return merged
	}
	if extension.Model != "" {
		merged.Model = extension.Model
	}
	if extension.InjectionKind != "" {
		merged.InjectionKind = extension.InjectionKind
	}
	if extension.DisplayText != "" {
		merged.DisplayText = extension.DisplayText
	}
	if extension.SlashModelTierApplyMidConversation != nil {
		merged.SlashModelTierApplyMidConversation = extension.SlashModelTierApplyMidConversation
	}
	merged.CommandContinuation = extension.CommandContinuation
	if len(extension.BashAllowlistAdditionsForThisPrompt) > 0 {
		merged.BashAllowlistAdditionsForThisPrompt = unionStrings(
			merged.BashAllowlistAdditionsForThisPrompt,
			extension.BashAllowlistAdditionsForThisPrompt,
		)
	}
	return merged
}
