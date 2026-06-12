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
// PlanModePromptResult with custom prompt, tool list, and/or sparse reminder
// text. The last non-nil result wins per field. Returns the custom prompt
// (empty = use default), tool list (nil = use default), and sparse reminder
// text (empty = use engine default buildPlanModeSparseReminder).
func (s *SDK) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string, string) {
	results := s.fire(HookPlanModePrompt, ctx, planFilePath)
	var outPrompt string
	var outTools []string
	var outSparseReminder string
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case PlanModePromptResult:
			if outPrompt == "" && v.Prompt != "" {
				outPrompt = v.Prompt
			}
			if outTools == nil && v.Tools != nil {
				outTools = v.Tools
			}
			if outSparseReminder == "" && v.SparseReminder != "" {
				outSparseReminder = v.SparseReminder
			}
		case *PlanModePromptResult:
			if v != nil {
				if outPrompt == "" && v.Prompt != "" {
					outPrompt = v.Prompt
				}
				if outTools == nil && v.Tools != nil {
					outTools = v.Tools
				}
				if outSparseReminder == "" && v.SparseReminder != "" {
					outSparseReminder = v.SparseReminder
				}
			}
		case string:
			if outPrompt == "" && v != "" {
				outPrompt = v
			}
		}
	}
	return outPrompt, outTools, outSparseReminder
}

// FireSystemInject fires the system_inject hook. Handlers may return a
// SystemInjectResult with custom Text or Suppress=true to prevent injection.
// Last non-nil result wins. If no handler returns a result, returns
// (defaultText, false).
func (s *SDK) FireSystemInject(ctx *Context, info SystemInjectInfo) (string, bool) {
	results := s.fire(HookSystemInject, ctx, info)
	text := info.DefaultText
	suppress := false
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case SystemInjectResult:
			if v.Suppress {
				return "", true
			}
			if v.Text != "" {
				return v.Text, false
			}
		case *SystemInjectResult:
			if v != nil {
				if v.Suppress {
					return "", true
				}
				if v.Text != "" {
					return v.Text, false
				}
			}
		case map[string]interface{}:
			if sup, ok := v["suppress"].(bool); ok && sup {
				return "", true
			}
			if t, ok := v["text"].(string); ok && t != "" {
				return t, false
			}
		}
	}
	return text, suppress
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
// a BeforeAgentStartResult with SystemPrompt and/or AgentName fields, or a map
// with "systemPrompt" / "agentName" keys (for JSON-RPC subprocess extensions).
// The last non-empty value wins for each field independently.
func (s *SDK) FireBeforeAgentStart(ctx *Context, info AgentInfo) (systemPrompt, agentName string, err error) {
	results := s.fire(HookBeforeAgentStart, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case BeforeAgentStartResult:
			if v.SystemPrompt != "" && systemPrompt == "" {
				systemPrompt = v.SystemPrompt
			}
			if v.AgentName != "" && agentName == "" {
				agentName = v.AgentName
			}
		case *BeforeAgentStartResult:
			if v != nil {
				if v.SystemPrompt != "" && systemPrompt == "" {
					systemPrompt = v.SystemPrompt
				}
				if v.AgentName != "" && agentName == "" {
					agentName = v.AgentName
				}
			}
		case map[string]interface{}:
			if sp, ok := v["systemPrompt"].(string); ok && sp != "" && systemPrompt == "" {
				systemPrompt = sp
			}
			if an, ok := v["agentName"].(string); ok && an != "" && agentName == "" {
				agentName = an
			}
		}
	}
	return systemPrompt, agentName, nil
}

// FireBeforeProviderRequest fires the before_provider_request hook. The
// payload is typically a BeforeProviderRequestInfo describing the pending
// outbound LLM request; callers may pass any value (the parameter is
// interface{} for forward compatibility with future payload shapes).
// Observe-only: handler return values are ignored.
func (s *SDK) FireBeforeProviderRequest(ctx *Context, payload interface{}) error {
	s.fire(HookBeforeProviderRequest, ctx, payload)
	return nil
}

// FireBeforeEarlyStopDecision fires the before_early_stop_decision hook and
// resolves the combined result from every handler. Per-field "last non-nil
// wins" merging mirrors FireBeforePrompt: if two handlers both set
// ForceContinue, the later-registered handler's value is kept.
//
// Returns a non-nil result whenever any field was set; nil means no handler
// expressed an opinion and the engine should use its default decision.
func (s *SDK) FireBeforeEarlyStopDecision(ctx *Context, info EarlyStopDecisionInfo) *EarlyStopDecisionResult {
	results := s.fire(HookBeforeEarlyStopDecision, ctx, info)
	if len(results) == 0 {
		return nil
	}
	var out EarlyStopDecisionResult
	anySet := false
	// Iterate forward, then later writers win because we keep overwriting.
	// Equivalent to "last non-nil wins" per field.
	for _, r := range results {
		var v *EarlyStopDecisionResult
		switch typed := r.(type) {
		case EarlyStopDecisionResult:
			v = &typed
		case *EarlyStopDecisionResult:
			v = typed
		case map[string]interface{}:
			// JSON-RPC subprocess extensions return decoded maps.
			tmp := EarlyStopDecisionResult{}
			if fc, ok := typed["forceContinue"].(bool); ok {
				tmp.ForceContinue = &fc
			}
			if ob, ok := typed["overrideBudget"].(float64); ok {
				tmp.OverrideBudget = int(ob)
			} else if ob, ok := typed["overrideBudget"].(int); ok {
				tmp.OverrideBudget = ob
			}
			if ot, ok := typed["overrideThresholdPct"].(float64); ok {
				tmp.OverrideThresholdPct = int(ot)
			} else if ot, ok := typed["overrideThresholdPct"].(int); ok {
				tmp.OverrideThresholdPct = ot
			}
			if cm, ok := typed["continueMessage"].(string); ok {
				tmp.ContinueMessage = cm
			}
			v = &tmp
		}
		if v == nil {
			continue
		}
		if v.ForceContinue != nil {
			out.ForceContinue = v.ForceContinue
			anySet = true
		}
		if v.OverrideBudget != 0 {
			out.OverrideBudget = v.OverrideBudget
			anySet = true
		}
		if v.OverrideThresholdPct != 0 {
			out.OverrideThresholdPct = v.OverrideThresholdPct
			anySet = true
		}
		if v.ContinueMessage != "" {
			out.ContinueMessage = v.ContinueMessage
			anySet = true
		}
	}
	if !anySet {
		return nil
	}
	return &out
}

// FireBeforePlanModeEnter fires the before_plan_mode_enter hook and resolves
// the combined allow/deny decision across all handlers. Per-field last-non-nil
// wins semantics: if multiple handlers express an opinion on Allow, the last
// registered handler's value is kept.
//
// Returns (allowed=true, reason="") by default when no handler expresses an
// opinion. Callers should proceed with plan mode entry when allowed=true.
func (s *SDK) FireBeforePlanModeEnter(ctx *Context, info PlanModeEnterInfo) (allowed bool, reason string) {
	results := s.fire(HookBeforePlanModeEnter, ctx, info)
	allowed = true // default: allow
	for _, r := range results {
		var v *BeforePlanModeEnterResult
		switch typed := r.(type) {
		case BeforePlanModeEnterResult:
			v = &typed
		case *BeforePlanModeEnterResult:
			v = typed
		case map[string]interface{}:
			// JSON-RPC subprocess extensions return decoded maps.
			tmp := BeforePlanModeEnterResult{}
			if a, ok := typed["allow"].(bool); ok {
				tmp.Allow = &a
			}
			if rs, ok := typed["reason"].(string); ok {
				tmp.Reason = rs
			}
			v = &tmp
		}
		if v == nil || v.Allow == nil {
			continue
		}
		// Last explicit decision wins.
		allowed = *v.Allow
		if !allowed && v.Reason != "" {
			reason = v.Reason
		}
	}
	return allowed, reason
}

// FireBeforePlanModeExit fires the before_plan_mode_exit hook and resolves the
// combined allow/deny decision across all handlers. Last non-nil Allow wins.
// Returns (allowed=true, reason="") when no handler expresses an opinion.
func (s *SDK) FireBeforePlanModeExit(ctx *Context, info BeforePlanModeExitInfo) (allowed bool, reason string) {
	results := s.fire(HookBeforePlanModeExit, ctx, info)
	allowed = true // default: allow
	for _, r := range results {
		var v *BeforePlanModeExitResult
		switch typed := r.(type) {
		case BeforePlanModeExitResult:
			v = &typed
		case *BeforePlanModeExitResult:
			v = typed
		case map[string]interface{}:
			tmp := BeforePlanModeExitResult{}
			if a, ok := typed["allow"].(bool); ok {
				tmp.Allow = &a
			}
			if rs, ok := typed["reason"].(string); ok {
				tmp.Reason = rs
			}
			v = &tmp
		}
		if v == nil || v.Allow == nil {
			continue
		}
		allowed = *v.Allow
		if !allowed && v.Reason != "" {
			reason = v.Reason
		}
	}
	return allowed, reason
}

// FireBeforePlanModeAutoExit fires the before_plan_mode_auto_exit hook and
// resolves the combined decision across all handlers. Last non-nil field
// wins per field (Suppress / PlanFilePath / Reason resolved independently).
//
// Returns:
//   - suppress: true when any handler set Suppress=true and no later
//     handler explicitly reset it. When true, the engine skips
//     synthesis entirely; the run completes as a normal end_turn and
//     the conversation stays parked in plan mode.
//   - planFilePathOverride: non-empty when a handler supplied a
//     replacement path; empty means "no override, use the engine's
//     resolved path."
//   - reasonOverride: non-empty when a handler supplied a replacement
//     reason string; empty means "use the engine default phrasing."
//
// When no handler expresses an opinion, returns (false, "", "") and
// the engine proceeds with defaults.
func (s *SDK) FireBeforePlanModeAutoExit(
	ctx *Context, info BeforePlanModeAutoExitInfo,
) (suppress bool, planFilePathOverride, reasonOverride string) {
	results := s.fire(HookBeforePlanModeAutoExit, ctx, info)
	for _, r := range results {
		var v *BeforePlanModeAutoExitResult
		switch typed := r.(type) {
		case BeforePlanModeAutoExitResult:
			v = &typed
		case *BeforePlanModeAutoExitResult:
			v = typed
		case map[string]interface{}:
			tmp := BeforePlanModeAutoExitResult{}
			if sp, ok := typed["suppress"].(bool); ok {
				tmp.Suppress = sp
			}
			if pf, ok := typed["planFilePath"].(string); ok {
				tmp.PlanFilePath = pf
			}
			if rs, ok := typed["reason"].(string); ok {
				tmp.Reason = rs
			}
			v = &tmp
		}
		if v == nil {
			continue
		}
		// Last-writer-wins per field. A handler that only sets
		// PlanFilePath does not clobber an earlier handler's Suppress
		// decision — matching the merge semantics documented on
		// BeforePlanModeAutoExitResult.
		if v.Suppress {
			suppress = true
		}
		if v.PlanFilePath != "" {
			planFilePathOverride = v.PlanFilePath
		}
		if v.Reason != "" {
			reasonOverride = v.Reason
		}
	}
	return suppress, planFilePathOverride, reasonOverride
}

// FireEarlyStopContinued fires the early_stop_continued hook. Observe-only:
// handler return values are ignored, errors are logged but not propagated.
// Fires after the continuation message has been written into the
// conversation, just before the next turn starts.
func (s *SDK) FireEarlyStopContinued(ctx *Context, info EarlyStopContinuedInfo) error {
	s.fire(HookEarlyStopContinued, ctx, info)
	return nil
}
