package extension

// FireSessionBeforeCompact fires the session_before_compact hook.
// If any handler returns true (as a bool), compaction is cancelled.
func (s *SDK) FireSessionBeforeCompact(ctx *Context, info CompactionInfo) (bool, error) {
	results := s.fire(HookSessionBeforeCompact, ctx, info)
	for _, r := range results {
		if cancel, ok := r.(bool); ok && cancel {
			return true, nil
		}
	}
	return false, nil
}

// FireSessionCompact fires the session_compact hook.
func (s *SDK) FireSessionCompact(ctx *Context, info CompactionInfo) error {
	s.fire(HookSessionCompact, ctx, info)
	return nil
}

// FireSessionBeforeFork fires the session_before_fork hook.
// If any handler returns true (as a bool), the fork is cancelled.
func (s *SDK) FireSessionBeforeFork(ctx *Context, info ForkInfo) (bool, error) {
	results := s.fire(HookSessionBeforeFork, ctx, info)
	for _, r := range results {
		if cancel, ok := r.(bool); ok && cancel {
			return true, nil
		}
	}
	return false, nil
}

// FireSessionFork fires the session_fork hook.
func (s *SDK) FireSessionFork(ctx *Context, info ForkInfo) error {
	s.fire(HookSessionFork, ctx, info)
	return nil
}

// FireSessionBeforeSwitch fires the session_before_switch hook.
func (s *SDK) FireSessionBeforeSwitch(ctx *Context) error {
	s.fire(HookSessionBeforeSwitch, ctx, nil)
	return nil
}

// FireCompactSummaryRequest fires the compact_summary_request hook and
// returns the first non-empty summary string a handler produced (along
// with ok=true). When no handler produces a non-empty summary, returns
// ("", false) so the engine falls back to its regex fact extractor.
//
// Handler return shape: either a CompactSummaryRequestResult value or a
// bare string. Bare strings are accepted because the natural extension
// shape (a single-line summariser that returns the summary directly) is
// strictly easier than constructing the result struct. Both paths flow
// through the same first-non-empty selection.
func (s *SDK) FireCompactSummaryRequest(ctx *Context, info CompactSummaryRequestInfo) (string, bool) {
	results := s.fire(HookCompactSummaryRequest, ctx, info)
	for _, r := range results {
		switch v := r.(type) {
		case CompactSummaryRequestResult:
			if v.Summary != "" {
				return v.Summary, true
			}
		case *CompactSummaryRequestResult:
			if v != nil && v.Summary != "" {
				return v.Summary, true
			}
		case string:
			if v != "" {
				return v, true
			}
		}
	}
	return "", false
}
