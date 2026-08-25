package server

// Tests for client-stated injection-kind validation on send_prompt
// (dispatch_injection_kind.go).
//
// The field exists so a client that owns its own answer surface — a Guided
// Questions wizard, a form, any structured input UI — can state that the turn
// it delivers is the engine-facing rendering of a submission rather than
// something the operator typed at the prompt. The engine classifies and
// publishes; suppression stays the consumer's policy.
//
// The security-relevant half is that a client cannot invent a kind: an
// unknown value must be dropped, because InjectionKind.IsMachineToMachine
// treats unknown as user-authored and persisting it would record a
// classification that changes nothing a consumer reads.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveClientInjectionKind(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty stays empty (ordinary user turn)", "", ""},
		{"structured answer accepted", "structured_answer", "structured_answer"},
		{"agent completion accepted", "agent_completion", "agent_completion"},
		{"revive accepted", "revive", "revive"},
		{"unknown kind dropped", "totally_made_up", ""},
		{"near-miss typo dropped", "structured_answers", ""},
		{"case mismatch dropped", "Structured_Answer", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveClientInjectionKind("sess-1", tc.in); got != tc.want {
				t.Errorf("resolveClientInjectionKind(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestResolveClientInjectionKind_AcceptsEveryKnownKind pins the validator to
// the enumerated set rather than a hand-copied list: a kind added to
// types.AllInjectionKinds is accepted here with no edit to either file. A
// validator with its own list would be the exact drift InjectionKind exists
// to eliminate.
func TestResolveClientInjectionKind_AcceptsEveryKnownKind(t *testing.T) {
	for _, k := range types.AllInjectionKinds {
		if k == types.InjectionKindNone {
			continue // the zero value is "no claim", covered above
		}
		if got := resolveClientInjectionKind("sess-1", string(k)); got != string(k) {
			t.Errorf("known kind %q was dropped (got %q) — the validator has drifted "+
				"from types.AllInjectionKinds", k, got)
		}
	}
}

// TestStructuredAnswerIsUserAuthored pins the classification a submitted
// answer set must carry.
//
// A person read the questions, chose the options, typed the text, and
// attached the images — the client contributed only the layout. Classifying
// that machine-authored (as an earlier revision did, to stop clients
// rendering it twice) bought de-duplication with a lie: consumers that hide
// machine turns dropped real operator input from the transcript entirely.
//
// The kind still tells a consumer the turn arrived through a structured
// surface, so a client can LABEL it rather than hide it. Classification
// here, presentation there.
func TestStructuredAnswerIsUserAuthored(t *testing.T) {
	if types.InjectionKindStructuredAnswer.IsMachineToMachine() {
		t.Fatal("structured_answer must classify as USER-authored: a human chose " +
			"every value, and hiding it drops real operator input from the transcript")
	}
}

// TestStructuredAnswerRemainsAKnownKind guards the other half: the kind must
// still be accepted from a client, because that is what lets a consumer
// distinguish a form submission from free text typed at the prompt.
func TestStructuredAnswerRemainsAKnownKind(t *testing.T) {
	if !types.InjectionKindStructuredAnswer.IsKnown() {
		t.Fatal("structured_answer must stay a known kind so clients can label the turn")
	}
	if got := resolveClientInjectionKind("sess-1", "structured_answer"); got != "structured_answer" {
		t.Fatalf("client-stated structured_answer must be accepted, got %q", got)
	}
}
