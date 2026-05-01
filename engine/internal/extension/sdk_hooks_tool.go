package extension

// FireToolCall fires the tool_call hook. If any handler returns a ToolCallResult
// with Block=true, the combined result blocks the call.
func (s *SDK) FireToolCall(ctx *Context, info ToolCallInfo) (*ToolCallResult, error) {
	results := s.fire(HookToolCall, ctx, info)
	for _, r := range results {
		if tcr, ok := r.(*ToolCallResult); ok && tcr.Block {
			return tcr, nil
		}
	}
	return nil, nil
}

// FireToolStart fires the tool_start hook.
func (s *SDK) FireToolStart(ctx *Context, info ToolStartInfo) error {
	s.fire(HookToolStart, ctx, info)
	return nil
}

// FireToolEnd fires the tool_end hook.
func (s *SDK) FireToolEnd(ctx *Context) error {
	s.fire(HookToolEnd, ctx, nil)
	return nil
}

// FireToolResult fires the tool_result hook.
func (s *SDK) FireToolResult(ctx *Context, info interface{}) error {
	s.fire(HookToolResult, ctx, info)
	return nil
}

// FirePerToolCall fires a per-tool call hook (e.g., bash_tool_call).
// If any handler returns a PerToolCallResult with Block=true, the call is blocked.
func (s *SDK) FirePerToolCall(ctx *Context, toolName string, info interface{}) (*PerToolCallResult, error) {
	hookName := toolName + "_tool_call"
	results := s.fire(hookName, ctx, info)
	for _, r := range results {
		if ptcr, ok := r.(*PerToolCallResult); ok && ptcr.Block {
			return ptcr, nil
		}
	}
	return nil, nil
}

// FirePerToolResult fires a per-tool result hook (e.g., bash_tool_result).
// If any handler returns a string, the content is modified; the last non-nil wins.
func (s *SDK) FirePerToolResult(ctx *Context, toolName string, info interface{}) (string, error) {
	hookName := toolName + "_tool_result"
	results := s.fire(hookName, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, nil
		}
	}
	return "", nil
}
