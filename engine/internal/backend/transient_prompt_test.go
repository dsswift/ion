package backend

import "testing"

func TestTransientPromptBackendParity(t *testing.T) {
	const user = "inspect failure"
	const workspace = "workspace facts"
	want := "<system-reminder>\nworkspace facts\n</system-reminder>\n\ninspect failure"

	if got := transientPrompt(user, workspace); got != want {
		t.Fatalf("transient prompt = %q, want %q", got, want)
	}
	if got := transientPrompt(user, ""); got != user {
		t.Fatalf("empty context changed prompt: %q", got)
	}
	// Resume uses same per-run options path as fresh runs. Prefixing must remain
	// deterministic rather than depending on backend session identity.
	if resumed := transientPrompt(user, workspace); resumed != want {
		t.Fatalf("resumed transient prompt = %q, want %q", resumed, want)
	}
}
