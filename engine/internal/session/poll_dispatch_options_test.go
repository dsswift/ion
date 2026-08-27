package session

import "testing"

func TestPollDispatchOptionsSuppressContextAndMutationTools(t *testing.T) {
	manager := &Manager{}
	opts := manager.pollDispatchOptions("session", "poll-1", "judge evidence", "model", t.TempDir())

	if opts.ContextPolicy == nil ||
		opts.ContextPolicy.IncludeGlobalContext == nil || *opts.ContextPolicy.IncludeGlobalContext ||
		opts.ContextPolicy.IncludeProjectContext == nil || *opts.ContextPolicy.IncludeProjectContext {
		t.Fatalf("Poll ContextPolicy = %+v, want both context layers explicitly false", opts.ContextPolicy)
	}

	allowed := make(map[string]bool, len(opts.AllowedTools))
	for _, name := range opts.AllowedTools {
		allowed[name] = true
	}
	for _, required := range []string{"Bash", "Read", "Grep", "Glob", "SearchHistory"} {
		if !allowed[required] {
			t.Errorf("Poll evidence allowlist is missing %q: %v", required, opts.AllowedTools)
		}
	}
	for _, forbidden := range []string{"Write", "Edit", "Poll", "Agent"} {
		if allowed[forbidden] {
			t.Errorf("Poll child may call mutating/orchestrating tool %q: %v", forbidden, opts.AllowedTools)
		}
	}
}
