package extension

// --- Capability Registry ---

// RegisterCapability adds a capability to the registry.
func (s *SDK) RegisterCapability(cap Capability) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.capabilities[cap.ID] = cap
}

// UnregisterCapability removes a capability by ID.
func (s *SDK) UnregisterCapability(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.capabilities, id)
}

// Capabilities returns all registered capabilities.
func (s *SDK) Capabilities() []Capability {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Capability, 0, len(s.capabilities))
	for _, cap := range s.capabilities {
		out = append(out, cap)
	}
	return out
}

// CapabilitiesByMode returns capabilities matching a mode flag.
func (s *SDK) CapabilitiesByMode(mode CapabilityMode) []Capability {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Capability
	for _, cap := range s.capabilities {
		if cap.Mode&mode != 0 {
			out = append(out, cap)
		}
	}
	return out
}

// --- Capability Hooks ---

// FireCapabilityDiscover fires the capability_discover hook. Extensions return
// capabilities to register. Called at session start.
func (s *SDK) FireCapabilityDiscover(ctx *Context) []Capability {
	results := s.fire(HookCapabilityDiscover, ctx, nil)
	var caps []Capability
	for _, r := range results {
		switch v := r.(type) {
		case []Capability:
			caps = append(caps, v...)
		case Capability:
			caps = append(caps, v)
		case []interface{}:
			for _, item := range v {
				if c, ok := item.(Capability); ok {
					caps = append(caps, c)
				}
			}
		}
	}
	return caps
}

// FireCapabilityMatch fires the capability_match hook. Extensions check if user
// input matches any registered capabilities and return matched IDs.
func (s *SDK) FireCapabilityMatch(ctx *Context, info CapabilityMatchInfo) *CapabilityMatchResult {
	results := s.fire(HookCapabilityMatch, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case *CapabilityMatchResult:
			if v != nil && len(v.MatchedIDs) > 0 {
				return v
			}
		case CapabilityMatchResult:
			if len(v.MatchedIDs) > 0 {
				return &v
			}
		}
	}
	return nil
}

// FireCapabilityInvoke fires the capability_invoke hook before a capability
// is executed. Extensions can block or modify the invocation.
func (s *SDK) FireCapabilityInvoke(ctx *Context, capID string, input map[string]interface{}) (blocked bool, reason string) {
	type invokeInfo struct {
		CapabilityID string                 `json:"capability_id"`
		Input        map[string]interface{} `json:"input"`
	}
	results := s.fire(HookCapabilityInvoke, ctx, invokeInfo{CapabilityID: capID, Input: input})
	for _, r := range results {
		if tr, ok := r.(*ToolCallResult); ok && tr.Block {
			return true, tr.Reason
		}
	}
	return false, ""
}
