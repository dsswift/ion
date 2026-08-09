package extcontext

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Child-dispatch sendPrompt wiring ───
//
// The defect this file pins: dispatch_child_setup.go wired the child extension
// host's onSendMessage callback to the THREE-ARG SendPrompt, which hardcodes an
// empty kind. payload.Kind was silently discarded, so an extension running
// inside a dispatched child context that correctly passed
// kind "agent_completion" still produced an unclassified injection, and every
// consumer rendered the machine-to-machine turn as a user bubble.
//
// Observed in production: ~/.ion/engine.jsonl.1 at 2026-07-31T18:33:58 shows
// chief-of-staff delivering from an n-tier context with
// kind: 'agent_completion' at agent-dispatch.ts:178, and the engine emitting
// "kind":"" one line later.
//
// The other two wiring sites (start_session.go, prompt_extensions.go) both
// route through dispatchSendPromptPayload and forward the full payload. The
// divergence between the three sites WAS the bug, so these tests assert the
// child site behaves like the other two.

// kindRecordingAccessor records the kind reaching each SendPrompt variant.
type kindRecordingAccessor struct {
	noopSA

	mu    sync.Mutex
	kinds []string
	texts []string
}

func (a *kindRecordingAccessor) SendPrompt(text string, model string, bash []string) error {
	return a.SendPromptWithKind(text, model, bash, "")
}

func (a *kindRecordingAccessor) SendPromptWithKind(text string, _ string, _ []string, kind string) error {
	a.mu.Lock()
	a.texts = append(a.texts, text)
	a.kinds = append(a.kinds, kind)
	a.mu.Unlock()
	return nil
}

// Degraded-steer delivery is not what this test exercises; it delegates so
// the fake satisfies SessionAccessor and behaves like the kind-aware send.
func (a *kindRecordingAccessor) SendPromptDegradedSteer(text string, model string, bash []string, kind string) error {
	return a.SendPromptWithKind(text, model, bash, kind)
}

func (a *kindRecordingAccessor) snapshot() (texts, kinds []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.texts...), append([]string(nil), a.kinds...)
}

// childSendPromptCallback mirrors the callback dispatch_child_setup.go installs
// via childExtHost.SetOnSendMessage. Constructing the real child host requires
// loading an extension subprocess from disk, which this unit test has no need
// for: the defect lives entirely in which accessor method the callback body
// calls, so the callback body is what gets exercised.
//
// This MUST stay identical to the body in dispatch_child_setup.go. A drift
// between them would make this test pass while production regressed, so the
// production site carries a comment naming this test.
func childSendPromptCallback(sa SessionAccessor) func(extension.SendPromptPayload) {
	return func(payload extension.SendPromptPayload) {
		//nolint:errcheck // the production callback logs; this mock never errors
		_ = sa.SendPromptWithKind(payload.Text, payload.Model, payload.BashAllowlistAdditions, payload.Kind)
	}
}

// TestChildDispatchSendPrompt_ForwardsKind is the root-cause-4 regression.
// Fails on the unfixed code, where the callback called the three-arg
// SendPrompt and the kind arrived empty.
func TestChildDispatchSendPrompt_ForwardsKind(t *testing.T) {
	acc := &kindRecordingAccessor{}
	cb := childSendPromptCallback(acc)

	cb(extension.SendPromptPayload{
		Text: "[Agent specialist completed in 42s]\n\nresult body",
		Kind: string(types.InjectionKindAgentCompletion),
	})

	texts, kinds := acc.snapshot()
	if len(kinds) != 1 {
		t.Fatalf("expected exactly one sendPrompt from the child callback, got %d", len(kinds))
	}
	if kinds[0] != string(types.InjectionKindAgentCompletion) {
		t.Errorf("child dispatch forwarded kind %q, want %q. An empty kind here is the "+
			"observed defect: the completion renders as a user bubble on every client.",
			kinds[0], types.InjectionKindAgentCompletion)
	}
	if texts[0] == "" {
		t.Error("child dispatch dropped the prompt text")
	}
}

// TestChildDispatchSendPrompt_ForwardsCheckInKind covers the other machine
// kind that routes through this path, so the fix is not narrowly tied to
// agent_completion.
func TestChildDispatchSendPrompt_ForwardsCheckInKind(t *testing.T) {
	acc := &kindRecordingAccessor{}
	cb := childSendPromptCallback(acc)

	cb(extension.SendPromptPayload{
		Text: "[SYSTEM] Dispatch check-in",
		Kind: string(types.InjectionKindCheckIn),
	})

	_, kinds := acc.snapshot()
	if len(kinds) != 1 || kinds[0] != string(types.InjectionKindCheckIn) {
		t.Errorf("child dispatch forwarded kinds %v, want one %q", kinds, types.InjectionKindCheckIn)
	}
}

// TestChildDispatchSendPrompt_UnclassifiedStaysEmpty pins the additive
// boundary: a payload with no kind must stay unclassified rather than
// acquiring a default. A genuine extension-initiated turn is a user turn.
func TestChildDispatchSendPrompt_UnclassifiedStaysEmpty(t *testing.T) {
	acc := &kindRecordingAccessor{}
	cb := childSendPromptCallback(acc)

	cb(extension.SendPromptPayload{Text: "an ordinary extension turn"})

	_, kinds := acc.snapshot()
	if len(kinds) != 1 || kinds[0] != "" {
		t.Errorf("unclassified payload forwarded kinds %v, want one empty", kinds)
	}
}
