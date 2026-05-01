package extension

// FireOnError fires the on_error hook.
func (s *SDK) FireOnError(ctx *Context, info ErrorInfo) error {
	s.fire(HookOnError, ctx, info)
	return nil
}

// FirePermissionRequest fires the permission_request hook.
func (s *SDK) FirePermissionRequest(ctx *Context, info PermissionRequestInfo) {
	s.fire(HookPermissionRequest, ctx, info)
}

// FirePermissionClassify fires the permission_classify hook. Handlers return
// a tier label (string). The first non-empty label wins; if no handler
// returns one, an empty string is returned and the engine falls back to its
// built-in SAFE/UNSAFE classifier.
func (s *SDK) FirePermissionClassify(ctx *Context, info PermissionClassifyInfo) string {
	results := s.fire(HookPermissionClassify, ctx, info)
	for _, r := range results {
		switch v := r.(type) {
		case string:
			if v != "" {
				return v
			}
		case map[string]interface{}:
			if t, ok := v["tier"].(string); ok && t != "" {
				return t
			}
			if t, ok := v["value"].(string); ok && t != "" {
				return t
			}
		}
	}
	return ""
}

// FirePermissionDenied fires the permission_denied hook.
func (s *SDK) FirePermissionDenied(ctx *Context, info PermissionDeniedInfo) {
	s.fire(HookPermissionDenied, ctx, info)
}

// FireFileChanged fires the file_changed hook.
func (s *SDK) FireFileChanged(ctx *Context, info FileChangedInfo) {
	s.fire(HookFileChanged, ctx, info)
}

// FireTaskCreated fires the task_created hook.
func (s *SDK) FireTaskCreated(ctx *Context, info TaskLifecycleInfo) {
	s.fire(HookTaskCreated, ctx, info)
}

// FireTaskCompleted fires the task_completed hook.
func (s *SDK) FireTaskCompleted(ctx *Context, info TaskLifecycleInfo) {
	s.fire(HookTaskCompleted, ctx, info)
}

// FireElicitationRequest fires the elicitation_request hook.
// Returns the first non-nil response from handlers.
func (s *SDK) FireElicitationRequest(ctx *Context, info ElicitationRequestInfo) (map[string]interface{}, error) {
	results := s.fire(HookElicitationRequest, ctx, info)
	for _, r := range results {
		if m, ok := r.(map[string]interface{}); ok {
			return m, nil
		}
	}
	return nil, nil
}

// FireElicitationResult fires the elicitation_result hook.
func (s *SDK) FireElicitationResult(ctx *Context, info ElicitationResultInfo) {
	s.fire(HookElicitationResult, ctx, info)
}

// FireExtensionRespawned fires extension_respawned on the freshly-respawned
// instance after init handshake. Lets the harness rebuild caches or
// re-acquire resources lost when the prior subprocess died.
func (s *SDK) FireExtensionRespawned(ctx *Context, info ExtensionRespawnedInfo) error {
	s.fire(HookExtensionRespawned, ctx, info)
	return nil
}

// FireTurnAborted fires turn_aborted on the freshly-respawned instance when
// the prior subprocess died with a turn in flight. The new instance never
// saw the turn's hook lifecycle, so this signals that some hook fires were
// missed and any per-turn state should be reset.
func (s *SDK) FireTurnAborted(ctx *Context, info TurnAbortedInfo) error {
	s.fire(HookTurnAborted, ctx, info)
	return nil
}

// FirePeerExtensionDied fires peer_extension_died on every Host in the
// group except the one that actually died. Lets surviving extensions
// degrade gracefully when a sibling becomes unavailable.
func (s *SDK) FirePeerExtensionDied(ctx *Context, info PeerExtensionInfo) error {
	s.fire(HookPeerExtensionDied, ctx, info)
	return nil
}

// FirePeerExtensionRespawned fires peer_extension_respawned on every Host
// in the group except the one that just respawned. Lets surviving
// extensions re-establish coordination with the recovered sibling.
func (s *SDK) FirePeerExtensionRespawned(ctx *Context, info PeerExtensionInfo) error {
	s.fire(HookPeerExtensionRespawned, ctx, info)
	return nil
}
