package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestParsePollChildAnswerIgnoresDispatchUsageSuffix(t *testing.T) {
	answer, err := parsePollChildAnswer(`{"verdict":"satisfied","evidence":"all checks passed"}

<usage>input_tokens=1 output_tokens=1</usage>`)
	if err != nil {
		t.Fatalf("parsePollChildAnswer: %v", err)
	}
	if answer.Verdict != types.PollVerdictSatisfied || answer.Evidence != "all checks passed" {
		t.Fatalf("answer = %#v", answer)
	}
}

func TestParsePollChildAnswerAcceptsStructuredEvidence(t *testing.T) {
	answer, err := parsePollChildAnswer(`{"verdict":"satisfied","evidence":["binary exists","guidance present"]}`)
	if err != nil {
		t.Fatalf("parsePollChildAnswer: %v", err)
	}
	if answer.Verdict != types.PollVerdictSatisfied || answer.Evidence != `["binary exists","guidance present"]` {
		t.Fatalf("answer = %#v", answer)
	}
}
