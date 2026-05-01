package extension

// FireContext fires the context hook.
func (s *SDK) FireContext(ctx *Context, payload interface{}) error {
	s.fire(HookContext, ctx, payload)
	return nil
}

// FireInput fires the input hook. Handlers may return a modified prompt;
// the last non-nil string result wins.
func (s *SDK) FireInput(ctx *Context, prompt string) (string, error) {
	results := s.fire(HookInput, ctx, prompt)
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, nil
		}
	}
	return prompt, nil
}

// FireModelSelect fires the model_select hook. Handlers may return a
// model ID string to override selection; the last non-nil result wins.
func (s *SDK) FireModelSelect(ctx *Context, info ModelSelectInfo) (string, error) {
	results := s.fire(HookModelSelect, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, nil
		}
	}
	return info.RequestedModel, nil
}

// FireUserBash fires the user_bash hook.
func (s *SDK) FireUserBash(ctx *Context, command string) error {
	s.fire(HookUserBash, ctx, command)
	return nil
}

// FireContextDiscover fires the context_discover hook.
// If any handler returns true (as a bool), the context file is rejected.
func (s *SDK) FireContextDiscover(ctx *Context, info ContextDiscoverInfo) (bool, error) {
	results := s.fire(HookContextDiscover, ctx, info)
	for _, r := range results {
		if reject, ok := r.(bool); ok && reject {
			return true, nil
		}
	}
	return false, nil
}

// FireContextLoad fires the context_load hook.
// Handlers may return a modified content string or true (bool) to reject.
func (s *SDK) FireContextLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	results := s.fire(HookContextLoad, ctx, info)
	for _, r := range results {
		if reject, ok := r.(bool); ok && reject {
			return "", true, nil
		}
	}
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, false, nil
		}
	}
	return info.Content, false, nil
}

// FireInstructionLoad fires the instruction_load hook.
func (s *SDK) FireInstructionLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	results := s.fire(HookInstructionLoad, ctx, info)
	for _, r := range results {
		if reject, ok := r.(bool); ok && reject {
			return "", true, nil
		}
	}
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, false, nil
		}
	}
	return info.Content, false, nil
}

// FireContextInject fires the context_inject hook. Extensions return additional
// context entries to inject into the system prompt.
func (s *SDK) FireContextInject(ctx *Context, info ContextInjectInfo) []ContextEntry {
	results := s.fire(HookContextInject, ctx, info)
	var entries []ContextEntry
	for _, r := range results {
		switch v := r.(type) {
		case []ContextEntry:
			entries = append(entries, v...)
		case ContextEntry:
			entries = append(entries, v)
		case []interface{}:
			for _, item := range v {
				if ce, ok := item.(ContextEntry); ok {
					entries = append(entries, ce)
				}
			}
		}
	}
	return entries
}
