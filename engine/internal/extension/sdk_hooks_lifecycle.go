package extension

// FireSessionStart fires the session_start hook.
func (s *SDK) FireSessionStart(ctx *Context) error {
	s.fire(HookSessionStart, ctx, nil)
	return nil
}

// FireSessionEnd fires the session_end hook.
func (s *SDK) FireSessionEnd(ctx *Context) error {
	s.fire(HookSessionEnd, ctx, nil)
	return nil
}

// FireBeforePrompt fires the before_prompt hook. Handlers may return a
// BeforePromptResult (with Prompt and/or SystemPrompt fields set), or a plain
// string (treated as a prompt rewrite for backward compatibility). The last
// non-nil result that provides each field wins.
// Returns the (possibly rewritten) prompt and an optional system prompt addition.
func (s *SDK) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	results := s.fire(HookBeforePrompt, ctx, prompt)
	outPrompt := prompt
	outSystem := ""
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case BeforePromptResult:
			if outPrompt == prompt && v.Prompt != "" {
				outPrompt = v.Prompt
			}
			if outSystem == "" && v.SystemPrompt != "" {
				outSystem = v.SystemPrompt
			}
		case *BeforePromptResult:
			if v != nil {
				if outPrompt == prompt && v.Prompt != "" {
					outPrompt = v.Prompt
				}
				if outSystem == "" && v.SystemPrompt != "" {
					outSystem = v.SystemPrompt
				}
			}
		case string:
			if outPrompt == prompt && v != "" {
				outPrompt = v
			}
		}
	}
	return outPrompt, outSystem, nil
}

// FirePlanModePrompt fires the plan_mode_prompt hook. Handlers may return a
// PlanModePromptResult with custom prompt and/or tool list. The last non-nil
// result wins. Returns the custom prompt (empty = use default) and tool list (nil = use default).
func (s *SDK) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string) {
	results := s.fire(HookPlanModePrompt, ctx, planFilePath)
	var outPrompt string
	var outTools []string
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case PlanModePromptResult:
			if outPrompt == "" && v.Prompt != "" {
				outPrompt = v.Prompt
			}
			if outTools == nil && v.Tools != nil {
				outTools = v.Tools
			}
		case *PlanModePromptResult:
			if v != nil {
				if outPrompt == "" && v.Prompt != "" {
					outPrompt = v.Prompt
				}
				if outTools == nil && v.Tools != nil {
					outTools = v.Tools
				}
			}
		case string:
			if outPrompt == "" && v != "" {
				outPrompt = v
			}
		}
	}
	return outPrompt, outTools
}

// FireTurnStart fires the turn_start hook.
func (s *SDK) FireTurnStart(ctx *Context, info TurnInfo) error {
	s.fire(HookTurnStart, ctx, info)
	return nil
}

// FireTurnEnd fires the turn_end hook.
func (s *SDK) FireTurnEnd(ctx *Context, info TurnInfo) error {
	s.fire(HookTurnEnd, ctx, info)
	return nil
}

// FireMessageStart fires the message_start hook.
func (s *SDK) FireMessageStart(ctx *Context) error {
	s.fire(HookMessageStart, ctx, nil)
	return nil
}

// FireMessageEnd fires the message_end hook.
func (s *SDK) FireMessageEnd(ctx *Context) error {
	s.fire(HookMessageEnd, ctx, nil)
	return nil
}

// FireMessageUpdate fires the message_update hook.
func (s *SDK) FireMessageUpdate(ctx *Context, info MessageUpdateInfo) error {
	s.fire(HookMessageUpdate, ctx, info)
	return nil
}

// FireAgentStart fires the agent_start hook.
func (s *SDK) FireAgentStart(ctx *Context, info AgentInfo) error {
	s.fire(HookAgentStart, ctx, info)
	return nil
}

// FireAgentEnd fires the agent_end hook.
func (s *SDK) FireAgentEnd(ctx *Context, info AgentInfo) error {
	s.fire(HookAgentEnd, ctx, info)
	return nil
}

// FireBeforeAgentStart fires the before_agent_start hook. Handlers may return
// a BeforeAgentStartResult with a SystemPrompt field, or a map with a
// "systemPrompt" key (for JSON-RPC subprocess extensions). The last non-empty
// system prompt wins.
func (s *SDK) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, error) {
	results := s.fire(HookBeforeAgentStart, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case BeforeAgentStartResult:
			if v.SystemPrompt != "" {
				return v.SystemPrompt, nil
			}
		case *BeforeAgentStartResult:
			if v != nil && v.SystemPrompt != "" {
				return v.SystemPrompt, nil
			}
		case map[string]interface{}:
			if sp, ok := v["systemPrompt"].(string); ok && sp != "" {
				return sp, nil
			}
		}
	}
	return "", nil
}

// FireBeforeProviderRequest fires the before_provider_request hook.
func (s *SDK) FireBeforeProviderRequest(ctx *Context, payload interface{}) error {
	s.fire(HookBeforeProviderRequest, ctx, payload)
	return nil
}
